//! The transport: everything that speaks HTTP, TLS or WebSocket.
//!
//! This layer translates; it holds no rules. Routes extract and validate the
//! request, call a service, and turn the result (or a `FsError`) into JSON.
//!
//! - [`listen`]: binding with the port walk (a busy port is not an error).
//! - [`tls`]: the self-signed certificate (rcgen) and the rustls config.
//! - [`server`]: the accept loop (connection cap, TLS handshake timeout,
//!   HTTP/1.1 with upgrades, the peer address for every request).
//! - [`state`]: [`state::AppState`], the services shared by every handler.
//! - [`guard`]: blacklist, host allow-list, CSRF origin check, sessions,
//!   activity and security headers - applied to every request.
//! - [`assets`]: the front end embedded in the binary (gzip, ETag).
//! - [`error`]: the JSON error body.
//! - [`body`]: a streaming file body for downloads and media ranges.
//! - [`routes`]: one module per feature, registered in `routes::ROUTES`.

pub mod assets;
pub mod body;
pub mod error;
pub mod guard;
pub mod listen;
pub mod routes;
pub mod server;
pub mod state;
pub mod tls;
