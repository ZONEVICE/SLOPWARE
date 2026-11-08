//! The page fallback: serves the embedded front end.
//!
//! - `/` is the editor for a logged-in browser and the login page otherwise
//!   (same URL, so a successful login just reloads it). It is never cached.
//! - `/assets/public/*`, `/login.html` and `/favicon.svg` are public: the
//!   login page needs them.
//! - Every other asset requires a session.
//! - Unknown `/api/*` paths are a JSON 404.

use axum::extract::{Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};

use super::super::assets;
use super::super::error::ApiError;
use super::super::guard::SessionCtx;
use super::super::state::AppState;

/// Fallback handler for everything no route matched.
pub async fn serve(State(state): State<AppState>, request: Request) -> Response {
    let path = request.uri().path();
    if path.starts_with("/api/") {
        return ApiError::new(StatusCode::NOT_FOUND, "not_found", "Unknown endpoint").into_response();
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let authed = matches!(request.extensions().get::<SessionCtx>(), Some(SessionCtx(Some(_))));
    let headers = request.headers();

    if path == "/" || path == "/index.html" {
        let page = if authed {
            // Loading the editor is something a person does.
            state.activity.touch();
            "/index.html"
        } else {
            "/login.html"
        };
        return match assets::find(page) {
            Some(asset) => {
                let mut response = assets::respond(asset, headers);
                response.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
                response
            }
            None => (StatusCode::INTERNAL_SERVER_ERROR, "front end missing from the binary").into_response(),
        };
    }
    if path == "/robots.txt" {
        let mut response = "User-agent: *\nDisallow: /\n".into_response();
        response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
        return response;
    }
    match assets::find(path) {
        Some(asset) if assets::is_public(path) || authed => assets::respond(asset, headers),
        Some(_) => (StatusCode::UNAUTHORIZED, "Log in first").into_response(),
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}
