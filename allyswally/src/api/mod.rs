//! The API layer: HTTP management endpoints and the WebSocket control channel.
//!
//! The web layer below (server.rs) parses a request and hands it here with a
//! [`ClientInfo`]; this layer holds the rules of what each endpoint does, using
//! the lower services through [`crate::state::AppState`]. Two transports meet
//! here and share the same services:
//!
//! * **HTTP** ([`http`]): management — PIN, MASKED CRUD, config, host info,
//!   power/server actions, export/import/reset, diagnostics.
//! * **WebSocket** ([`ws`]): the low-latency control channel — mouse, keyboard,
//!   shortcut execution, heartbeat.
//!
//! Adding an HTTP endpoint is one match arm in [`http::handle`]; adding a
//! WebSocket command is one arm in [`ws::handle_message`].

pub mod bundle;
pub mod host;
pub mod http;
pub mod items;
pub mod run;
pub mod ws;

use std::net::IpAddr;

/// What the web layer knows about the client making a request.
pub struct ClientInfo {
    pub ip: IpAddr,
    /// The `X-Token` header value, if present (validated by the handler).
    pub token: Option<String>,
    pub user_agent: String,
}

impl ClientInfo {
    /// True when this request carries a valid session token.
    pub fn authenticated(&self, state: &crate::state::AppState) -> bool {
        self.token
            .as_deref()
            .map(|t| state.auth.check_token(t))
            .unwrap_or(false)
    }
}
