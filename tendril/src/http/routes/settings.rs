//! The Settings tab's API over `~/.tendril/settings.json`.
//!
//! - `GET /api/settings` -> `{settings, meta}`; the password is never sent,
//!   only `password_set`.
//! - `PATCH /api/settings` with a JSON merge patch -> the new settings.
//!   Changes apply at once where they can (idle timeout, log limits, the
//!   password unless `--password` was given); `port` and `bind` apply at the
//!   next start.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use serde_json::{Value, json};

use super::super::error::{ApiError, ApiResult};
use super::super::guard::Authed;
use super::super::state::AppState;
use super::Routes;
use crate::config::settings::{Settings, SettingsError};
use crate::services::auth::PasswordSource;
use crate::services::events::Event;

/// Registers the routes.
pub fn register(mut routes: Routes) -> Routes {
    routes.private = routes.private.route("/api/settings", get(read).patch(update));
    routes
}

fn view(state: &AppState, settings: &Settings) -> Value {
    json!({
        "settings": settings.public_json(),
        "meta": {
            "path": state.settings.path().to_string_lossy(),
            "password_source": state.auth.password_source().as_str(),
            "password_from_cli": state.info.password_from_cli,
            "restart_keys": ["port", "bind"],
        }
    })
}

async fn read(State(state): State<AppState>, _authed: Authed) -> Json<Value> {
    let settings = state.settings.get();
    Json(view(&state, &settings))
}

async fn update(State(state): State<AppState>, authed: Authed, Json(patch): Json<Value>) -> ApiResult<Json<Value>> {
    let (settings, changed) = state.settings.apply_patch(&patch).map_err(|err| match err {
        SettingsError::Invalid(msg) => ApiError::new(StatusCode::BAD_REQUEST, "invalid_settings", msg),
        SettingsError::Io(err) => ApiError::internal(format!("could not save settings.json: {err}")),
    })?;
    if changed.iter().any(|k| k == "idle_timeout_minutes") {
        state.activity.set_timeout_minutes(settings.idle_timeout_minutes);
    }
    if changed.iter().any(|k| k.starts_with("log_")) {
        state.logger.set_limits(settings.log_retention_days, settings.log_max_total_mb);
        state.logger.prune();
    }
    if changed.iter().any(|k| k == "password") && !state.info.password_from_cli {
        // A cleared password keeps the current one until the next start.
        if let Some(password) = settings.password() {
            state.auth.set_password(password, PasswordSource::Settings);
            state.publish(Event::PasswordChanged { ip: authed.ip.to_string() });
        }
    }
    if !changed.is_empty() {
        state.publish(Event::SettingsChanged { ip: authed.ip.to_string(), keys: changed });
    }
    Ok(Json(view(&state, &settings)))
}
