//! Tendril: a lightweight web code editor served by one self-contained binary.
//!
//! Layers, from the bottom up. A layer only uses the layers above it in this
//! list; nothing imports "upwards":
//!
//! 1. [`core`] - primitives with no knowledge of the application (time,
//!    randomness, atomic files, JSON files, network facts).
//! 2. [`config`] - the data directory, `settings.json`, the command line.
//! 3. [`services`] - the rules: events (the pub/sub seam), logs,
//!    authentication, activity, workspaces and files, terminals.
//! 4. [`http`] - the transport: accept loop, TLS, guards, routes, assets.
//! 5. [`app`] and [`console`] - the composition root and what it prints.
//!
//! `main.rs` only parses the command line and calls [`app::run`]. The library
//! exists so integration tests (`tests/`) can start real instances in
//! process.

pub mod app;
pub mod config;
pub mod console;
pub mod core;
pub mod http;
pub mod services;
