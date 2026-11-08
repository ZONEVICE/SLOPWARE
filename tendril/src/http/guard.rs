//! Request guards, applied in this order to **every** request:
//!
//! 1. **Blacklist.** An IP that used up its password attempts gets 403 for
//!    everything (logged, rate-limited) until the process restarts.
//! 2. **Host allow-list.** When `allowed_hosts` is set, other `Host` headers
//!    get 421 (defence against DNS rebinding in plain-HTTP mode). Loopback
//!    names are always allowed.
//! 3. **Origin check (CSRF).** Requests that change state (anything but
//!    GET/HEAD/OPTIONS) and WebSocket upgrades must carry an `Origin` equal to
//!    `<scheme>://<Host>`. Together with `SameSite=Strict` cookies this stops
//!    other sites from acting through the user's browser - including spending
//!    the user's three password attempts.
//! 4. **Session.** The session cookie is resolved and attached as
//!    [`SessionCtx`]; routes that need one use the [`Authed`] or [`Ws`]
//!    extractors behind [`require_session`], which also records user
//!    activity unless the browser marked the request `X-Tendril-Quiet`.
//! 5. **Security headers** on the way out: a strict Content-Security-Policy
//!    (no inline scripts, no `eval`), `nosniff`, `no-referrer`, framing only
//!    by the same origin (the PDF viewer), COOP/CORP same-origin, and
//!    `no-store` on API responses. Images may also come from other servers
//!    (`https:`, plus `http:` when Tendril itself runs on HTTP, where it
//!    adds no mixed content), for the Markdown preview; `no-referrer` keeps
//!    those servers from learning Tendril's address.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;

use axum::extract::{FromRequestParts, Query, Request, State};
use axum::http::header::{CACHE_CONTROL, CONNECTION, CONTENT_TYPE, COOKIE, HOST, ORIGIN, UPGRADE};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::error::ApiError;
use super::server::PeerIp;
use super::state::AppState;
use crate::config::cli::Scheme;
use crate::core::lock::LockExt;
use crate::services::auth::SessionId;
use crate::services::events::Event;
use crate::services::files::jail::Jail;

/// Header the browser adds to automatic requests (polls, refreshes) so they
/// do not count as user activity.
pub const QUIET_HEADER: &str = "x-tendril-quiet";
/// Header carrying the workspace id.
pub const WORKSPACE_HEADER: &str = "x-tendril-workspace";

/// The session resolved from the cookie, if any.
#[derive(Debug, Clone, Copy)]
pub struct SessionCtx(pub Option<SessionId>);

/// The outermost middleware (see the module docs).
pub async fn guard(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    let ip = peer_ip(request.extensions().get::<PeerIp>());
    let path = request.uri().path().to_string();
    let host = request.headers().get(HOST).and_then(|h| h.to_str().ok()).map(str::to_string);

    if state.auth.is_blocked(ip) {
        note_blocked(&state, ip, &path);
        return secure(blocked(&path), state.info.scheme, None);
    }
    if !host_allowed(&state.settings.get().allowed_hosts, host.as_deref()) {
        state.publish(Event::Rejected { ip: ip.to_string(), path, reason: "host not allowed".into() });
        return secure((StatusCode::MISDIRECTED_REQUEST, "Unknown host").into_response(), state.info.scheme, None);
    }
    if needs_origin_check(request.method(), request.headers())
        && !origin_matches(request.headers(), state.info.scheme, host.as_deref())
    {
        state.publish(Event::Rejected { ip: ip.to_string(), path, reason: "cross-origin request".into() });
        let error = ApiError::new(StatusCode::FORBIDDEN, "cross_origin", "Cross-origin requests are not allowed");
        return secure(error.into_response(), state.info.scheme, host.as_deref());
    }
    let session = session_token(request.headers(), state.info.cookie_name()).and_then(|t| state.auth.verify(&t));
    request.extensions_mut().insert(SessionCtx(session));

    let is_api = path.starts_with("/api/");
    let mut response = next.run(request).await;
    if is_api && !response.headers().contains_key(CACHE_CONTROL) {
        response.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    secure(response, state.info.scheme, host.as_deref())
}

/// Route layer for the private routes: 401 without a session; records
/// activity for requests the browser did not mark as automatic.
pub async fn require_session(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let authed = matches!(request.extensions().get::<SessionCtx>(), Some(SessionCtx(Some(_))));
    if !authed {
        return ApiError::unauthorized().into_response();
    }
    if !request.headers().contains_key(QUIET_HEADER) && !PASSIVE.contains(&request.uri().path()) {
        state.activity.touch();
    }
    next.run(request).await
}

/// Endpoints that never count as user activity, whatever the browser says.
pub const PASSIVE: &[&str] = &["/api/system/status"];

fn peer_ip(peer: Option<&PeerIp>) -> IpAddr {
    peer.map(|p| p.0).unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
}

/// Logs the first requests of a blocked IP, then one in a hundred.
fn note_blocked(state: &AppState, ip: IpAddr, path: &str) {
    let count = {
        let mut hits = state.blocked_hits.locked();
        let count = hits.entry(ip).or_insert(0);
        *count += 1;
        *count
    };
    if count <= 5 || count % 100 == 0 {
        state.publish(Event::BlockedRequest { ip: ip.to_string(), path: path.to_string() });
    }
}

fn blocked(path: &str) -> Response {
    if path.starts_with("/api/") {
        return ApiError::new(
            StatusCode::FORBIDDEN,
            "blocked",
            "This address is blocked after too many wrong passwords. Restart Tendril on the host to clear it.",
        )
        .into_response();
    }
    let page = "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\">\
        <title>Tendril - blocked</title><body style=\"font:16px system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0\">\
        <main style=\"max-width:30rem;padding:1.5rem;text-align:center\"><h1 style=\"font-size:1.3rem\">Access blocked</h1>\
        <p>Too many wrong passwords were entered from this address.</p>\
        <p style=\"opacity:.7\">The block is lifted only when Tendril is restarted on the host.</p></main>";
    let mut response = (StatusCode::FORBIDDEN, page).into_response();
    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    response
}

/// True when `host` may be served.
pub fn host_allowed(allowed: &[String], host: Option<&str>) -> bool {
    if allowed.is_empty() {
        return true;
    }
    let Some(host) = host else { return false };
    let host = host.to_ascii_lowercase();
    let name = strip_port(&host);
    if matches!(name, "localhost" | "127.0.0.1" | "[::1]") {
        return true;
    }
    allowed.iter().any(|entry| {
        let entry = entry.trim().to_ascii_lowercase();
        entry == host || ((!entry.contains(':') || entry.starts_with('[')) && entry == name)
    })
}

/// `example.com:6060` -> `example.com`; `[::1]:6060` -> `[::1]`.
fn strip_port(host: &str) -> &str {
    if host.starts_with('[') {
        return host.split_once(']').map(|(h, _)| &host[..h.len() + 1]).unwrap_or(host);
    }
    host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host)
}

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    let upgrade = headers.get(UPGRADE).and_then(|v| v.to_str().ok()).unwrap_or("");
    let connection = headers.get(CONNECTION).and_then(|v| v.to_str().ok()).unwrap_or("");
    upgrade.eq_ignore_ascii_case("websocket") || connection.to_ascii_lowercase().contains("upgrade")
}

/// State-changing methods and WebSocket upgrades need the origin check.
pub fn needs_origin_check(method: &Method, headers: &HeaderMap) -> bool {
    !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) || is_websocket_upgrade(headers)
}

/// True when `Origin` is exactly `<scheme>://<Host>`.
pub fn origin_matches(headers: &HeaderMap, scheme: Scheme, host: Option<&str>) -> bool {
    let (Some(origin), Some(host)) = (headers.get(ORIGIN).and_then(|v| v.to_str().ok()), host) else {
        return false;
    };
    let expected = format!("{}://{}", scheme.as_str(), host);
    origin.eq_ignore_ascii_case(&expected)
}

/// The session token from the `Cookie` header(s).
pub fn session_token(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.trim().to_string())
}

/// The `Set-Cookie` value that stores a session token.
pub fn session_cookie(name: &str, token: &str, scheme: Scheme) -> String {
    let secure = if scheme == Scheme::Https { "; Secure" } else { "" };
    format!("{name}={token}; Path=/; HttpOnly; SameSite=Strict{secure}")
}

/// The `Set-Cookie` value that deletes the session cookie.
pub fn clear_cookie(name: &str, scheme: Scheme) -> String {
    let secure = if scheme == Scheme::Https { "; Secure" } else { "" };
    format!("{name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{secure}")
}

/// A host value safe to place inside the CSP header.
fn csp_host(host: Option<&str>) -> Option<&str> {
    host.filter(|h| {
        !h.is_empty()
            && h.len() < 256
            && h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
    })
}

/// Adds the security headers to a response.
pub fn secure(mut response: Response, scheme: Scheme, host: Option<&str>) -> Response {
    let headers = response.headers_mut();
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("x-frame-options", HeaderValue::from_static("SAMEORIGIN"));
    headers.insert("cross-origin-opener-policy", HeaderValue::from_static("same-origin"));
    headers.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static(
            "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
        ),
    );
    if !headers.contains_key("content-security-policy") {
        let ws = match (csp_host(host), scheme) {
            (Some(h), Scheme::Https) => format!(" wss://{h}"),
            (Some(h), Scheme::Http) => format!(" ws://{h}"),
            (None, _) => String::new(),
        };
        let remote_images = match scheme {
            Scheme::Https => "https:",
            Scheme::Http => "https: http:",
        };
        let csp = format!(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' data: blob: {remote_images}; \
             media-src 'self' blob:; font-src 'self' data:; connect-src 'self'{ws}; worker-src 'self' blob:; \
             child-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; \
             frame-ancestors 'self'"
        );
        if let Ok(value) = HeaderValue::from_str(&csp) {
            headers.insert("content-security-policy", value);
        }
    }
    response
}

/// An authenticated request: the session and the client address.
#[derive(Debug, Clone, Copy)]
pub struct Authed {
    pub session: SessionId,
    pub ip: IpAddr,
}

impl<S: Send + Sync> FromRequestParts<S> for Authed {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let Some(SessionCtx(Some(session))) = parts.extensions.get::<SessionCtx>().copied() else {
            return Err(ApiError::unauthorized());
        };
        Ok(Authed { session, ip: peer_ip(parts.extensions.get::<PeerIp>()) })
    }
}

/// An authenticated request inside a workspace (header `X-Tendril-Workspace`
/// or query parameter `ws`).
pub struct Ws {
    pub id: String,
    pub jail: Arc<Jail>,
    pub session: SessionId,
    pub ip: IpAddr,
}

#[derive(Deserialize)]
struct WsQuery {
    ws: Option<String>,
}

impl FromRequestParts<AppState> for Ws {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let authed = Authed::from_request_parts(parts, state).await?;
        let id = match parts.headers.get(WORKSPACE_HEADER).and_then(|v| v.to_str().ok()) {
            Some(id) => id.to_string(),
            None => Query::<WsQuery>::try_from_uri(&parts.uri)
                .ok()
                .and_then(|q| q.0.ws)
                .ok_or_else(ApiError::no_workspace)?,
        };
        let jail = state.workspaces.get(authed.session, &id).ok_or_else(ApiError::no_workspace)?;
        Ok(Ws { id, jail, session: authed.session, ip: authed.ip })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_allow_list() {
        let none: Vec<String> = Vec::new();
        assert!(host_allowed(&none, Some("anything:6060")));
        let list = vec!["editor.example.com".to_string(), "10.0.0.5:6060".to_string()];
        assert!(host_allowed(&list, Some("editor.example.com")));
        assert!(host_allowed(&list, Some("editor.example.com:6060")));
        assert!(host_allowed(&list, Some("10.0.0.5:6060")));
        assert!(!host_allowed(&list, Some("10.0.0.5:7000")));
        assert!(!host_allowed(&list, Some("evil.example")));
        assert!(!host_allowed(&list, None));
        assert!(host_allowed(&list, Some("localhost:6060")));
        assert!(host_allowed(&list, Some("[::1]:6060")));
    }

    #[test]
    fn origin_check() {
        let mut h = HeaderMap::new();
        assert!(!origin_matches(&h, Scheme::Https, Some("box:6060")));
        h.insert(ORIGIN, HeaderValue::from_static("https://box:6060"));
        assert!(origin_matches(&h, Scheme::Https, Some("box:6060")));
        assert!(!origin_matches(&h, Scheme::Http, Some("box:6060")));
        assert!(!origin_matches(&h, Scheme::Https, Some("other:6060")));
        h.insert(ORIGIN, HeaderValue::from_static("null"));
        assert!(!origin_matches(&h, Scheme::Https, Some("box:6060")));
        assert!(needs_origin_check(&Method::POST, &HeaderMap::new()));
        assert!(!needs_origin_check(&Method::GET, &HeaderMap::new()));
        let mut ws = HeaderMap::new();
        ws.insert(UPGRADE, HeaderValue::from_static("websocket"));
        assert!(needs_origin_check(&Method::GET, &ws));
    }

    #[test]
    fn cookies() {
        let mut h = HeaderMap::new();
        h.insert(COOKIE, HeaderValue::from_static("a=1; __Host-tendril=abc; b=2"));
        assert_eq!(session_token(&h, "__Host-tendril").as_deref(), Some("abc"));
        assert_eq!(session_token(&h, "tendril"), None);
        let set = session_cookie("__Host-tendril", "abc", Scheme::Https);
        assert!(set.contains("HttpOnly") && set.contains("SameSite=Strict") && set.contains("Secure"));
        assert!(!session_cookie("tendril", "abc", Scheme::Http).contains("Secure"));
        assert!(clear_cookie("tendril", Scheme::Http).contains("Max-Age=0"));
    }

    #[test]
    fn remote_images_follow_the_scheme() {
        let csp = |scheme| {
            let response = secure(Response::new(axum::body::Body::empty()), scheme, Some("box:6060"));
            response.headers()["content-security-policy"].to_str().unwrap().to_string()
        };
        let https = csp(Scheme::Https);
        assert!(https.contains("img-src 'self' data: blob: https:;"), "{https}");
        let http = csp(Scheme::Http);
        assert!(http.contains("img-src 'self' data: blob: https: http:;"), "{http}");
        // Scripts stay local whatever the scheme.
        assert!(https.contains("script-src 'self';") && http.contains("script-src 'self';"));
    }

    #[test]
    fn csp_host_is_sanitised() {
        assert_eq!(csp_host(Some("box:6060")), Some("box:6060"));
        assert_eq!(csp_host(Some("[::1]:6060")), Some("[::1]:6060"));
        assert_eq!(csp_host(Some("evil; script-src *")), None);
    }
}
