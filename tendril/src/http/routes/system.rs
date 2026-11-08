//! Process-level endpoints.
//!
//! - `GET /api/system/status` -> idle timeout and time left. Polled by the
//!   browser; **never** counts as activity (see `guard::PASSIVE`).
//! - `POST /api/system/ping` -> records activity. The browser sends it, at
//!   most once a minute, while a person types or clicks without otherwise
//!   talking to the server (editing a long file before saving).
//! - `GET /api/system/info` -> facts for the Settings tab: version, mode,
//!   addresses, paths, fingerprint, memory, sessions, terminals, blocked IPs.
//! - `POST /api/system/shutdown` -> stops the process (after the reply).

use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::routing::{get, post};
use serde_json::{Value, json};

use super::super::guard::Authed;
use super::super::state::AppState;
use super::Routes;
use crate::core::{clock, procinfo};

/// Registers the routes.
pub fn register(mut routes: Routes) -> Routes {
    routes.private = routes
        .private
        .route("/api/system/status", get(status))
        .route("/api/system/ping", post(ping))
        .route("/api/system/info", get(info))
        .route("/api/system/shutdown", post(shutdown));
    routes
}

async fn status(State(state): State<AppState>, _authed: Authed) -> Json<Value> {
    Json(json!({
        "version": state.info.version,
        "idle_timeout_secs": state.activity.timeout().as_secs(),
        "idle_remaining_secs": state.activity.remaining().as_secs(),
    }))
}

async fn ping(State(state): State<AppState>, _authed: Authed) -> Json<Value> {
    Json(json!({ "idle_remaining_secs": state.activity.remaining().as_secs() }))
}

async fn info(State(state): State<AppState>, _authed: Authed) -> Json<Value> {
    let info = &state.info;
    Json(json!({
        "version": info.version,
        "scheme": info.scheme.as_str(),
        "addr": info.addr.to_string(),
        "pid": std::process::id(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "started": info.started_ms,
        "uptime_secs": clock::unix_ms().saturating_sub(info.started_ms) / 1000,
        "data_dir": info.data_dir.to_string_lossy(),
        "logs_dir": state.logger.dir().to_string_lossy(),
        "settings_file": state.settings.path().to_string_lossy(),
        "fingerprint": info.fingerprint,
        "memory_bytes": procinfo::resident_bytes(),
        "sessions": state.auth.session_count(),
        "terminals": state.terminals.count(),
        "blocked_ips": state.auth.blocked_ips().iter().map(|ip| ip.to_string()).collect::<Vec<_>>(),
        "password_source": state.auth.password_source().as_str(),
    }))
}

async fn shutdown(State(state): State<AppState>, authed: Authed) -> Json<Value> {
    let reason = format!("stopped from the Settings tab by {}", authed.ip);
    let later = state.clone();
    tokio::spawn(async move {
        // Let the reply reach the browser first.
        tokio::time::sleep(Duration::from_millis(300)).await;
        later.shutdown.trigger(reason);
    });
    Json(json!({ "ok": true }))
}
