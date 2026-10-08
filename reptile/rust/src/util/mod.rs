//! Dependency-free helpers (beyond the crypto crates): clocks, identifiers,
//! logging, the event bus, wire paths, network math, URL encoding, operating
//! system facts, port selection, certificates and thread primitives. Nothing
//! here knows about synchronisation rules.

pub mod cert;
pub mod events;
pub mod ids;
pub mod listen;
pub mod logger;
pub mod net;
pub mod sys;
pub mod threads;
pub mod time;
pub mod url;
pub mod wire;
