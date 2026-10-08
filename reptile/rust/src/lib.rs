//! Reptile: real-time two-way directory synchronisation between two
//! computers on a LAN, over HTTP or HTTPS. Wire-compatible with the Node.js
//! implementation in `../node`: a Rust instance and a Node.js instance find,
//! host and sync with each other.
//!
//! Dependencies flow one way and never back up:
//!
//! ```text
//! config -> util -> fs -> domain -> peer (outgoing HTTP) -+
//!                          |                              +-> app wires them together
//!                          +- events -> http (routes, SSE)-+
//!                                    +> reporters
//! ```

pub mod app;
pub mod config;
pub mod domain;
pub mod fs;
pub mod http;
pub mod peer;
pub mod reporters;
pub mod util;
