//! Login and logout.
//!
//! `POST /api/auth/login {password}` (public):
//! - 200 `{ok: true}` + session cookie;
//! - 401 `{error: "wrong_password", remaining}`;
//! - 403 `{error: "blocked"}` on the third failure (later requests from that
//!   IP never get here: the guard answers 403 first).
//!
//! `POST /api/auth/logout` (private) ends the session and its workspaces.

use std::time::Duration;

use axum::extract::State;
use axum::http::header::SET_COOKIE;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;

use super::super::error::{ApiError, ApiResult};
use super::super::guard::{self, Authed};
use super::super::server::PeerIp;
use super::super::state::AppState;
use super::Routes;
use crate::services::auth::{LoginResult, MAX_FAILURES};
use crate::services::events::Event;

/// Registers the routes.
pub fn register(mut routes: Routes) -> Routes {
    routes.public = routes.public.route("/api/auth/login", post(login));
    routes.private = routes.private.route("/api/auth/logout", post(logout));
    routes
}

#[derive(Deserialize)]
struct LoginBody {
    password: String,
}

async fn login(
    State(state): State<AppState>,
    Extension(PeerIp(ip)): Extension<PeerIp>,
    Json(body): Json<LoginBody>,
) -> ApiResult<Response> {
    if body.password.chars().count() > 1024 {
        return Err(ApiError::bad_request("password too long"));
    }
    match state.auth.login(ip, &body.password) {
        LoginResult::Ok { token, .. } => {
            state.activity.touch();
            state.publish(Event::LoginOk { ip: ip.to_string() });
            let cookie = guard::session_cookie(state.info.cookie_name(), &token, state.info.scheme);
            let mut response = Json(json!({ "ok": true })).into_response();
            response
                .headers_mut()
                .insert(SET_COOKIE, HeaderValue::from_str(&cookie).map_err(|_| ApiError::internal("invalid cookie"))?);
            Ok(response)
        }
        LoginResult::Wrong { remaining } => {
            state.publish(Event::LoginFailed { ip: ip.to_string(), failures: MAX_FAILURES - remaining });
            // A short pause makes scripted guessing slower still.
            tokio::time::sleep(Duration::from_millis(400)).await;
            Err(ApiError::new(StatusCode::UNAUTHORIZED, "wrong_password", "Wrong password")
                .with("remaining", remaining))
        }
        LoginResult::Blocked { just_now } => {
            if just_now {
                state.publish(Event::LoginFailed { ip: ip.to_string(), failures: MAX_FAILURES });
                state.publish(Event::IpBlocked { ip: ip.to_string() });
            }
            Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "blocked",
                "Too many wrong passwords. This address is blocked until Tendril is restarted on the host.",
            ))
        }
    }
}

async fn logout(State(state): State<AppState>, authed: Authed) -> Response {
    state.auth.logout(authed.session);
    state.workspaces.drop_session(authed.session);
    state.publish(Event::Logout { ip: authed.ip.to_string() });
    let mut response = Json(json!({ "ok": true })).into_response();
    if let Ok(value) = HeaderValue::from_str(&guard::clear_cookie(state.info.cookie_name(), state.info.scheme)) {
        response.headers_mut().insert(SET_COOKIE, value);
    }
    response
}
