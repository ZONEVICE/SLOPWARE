//! The instance-to-instance protocol: names shared by the host side (the peer
//! routes), the syncing side (the peer client) and the services.
//!
//! This is the contract with the Node.js implementation: a Rust instance and a
//! Node.js instance sync with each other, so nothing here may change without
//! changing it there too (and bumping `PROTOCOL_VERSION` if it breaks).
//!
//!   GET  /api/ping               who are you? (public, used by discovery)
//!   POST /api/peer/connect       PIN in, bearer token out
//!   GET  /api/peer/stream        long-lived NDJSON: host -> peer events
//!   GET  /api/peer/manifest      every shared entry with size and mtime
//!   POST /api/peer/hashes        SHA-256 of selected files
//!   GET  /api/peer/file?path=    download one file
//!   PUT  /api/peer/file?path=    upload one file (raw body)
//!   POST /api/peer/ops           mkdir / unlink / rmdir / rename, in order
//!   POST /api/peer/heartbeat     "still here", plus the peer's sync phase
//!   POST /api/peer/disconnect    leaving on purpose
//!
//! The peer always initiates, so the host never needs to reach the peer.

pub const PROTOCOL_VERSION: u32 = 1;

pub mod paths {
    pub const PING: &str = "/api/ping";
    pub const CONNECT: &str = "/api/peer/connect";
    pub const STREAM: &str = "/api/peer/stream";
    pub const MANIFEST: &str = "/api/peer/manifest";
    pub const HASHES: &str = "/api/peer/hashes";
    pub const FILE: &str = "/api/peer/file";
    pub const OPS: &str = "/api/peer/ops";
    pub const HEARTBEAT: &str = "/api/peer/heartbeat";
    pub const DISCONNECT: &str = "/api/peer/disconnect";
}

/// Messages on the host -> peer stream.
pub mod stream {
    pub const HELLO: &str = "hello";
    pub const OPS: &str = "ops";
    pub const HEARTBEAT: &str = "heartbeat";
    pub const BYE: &str = "bye";
}

/// Why a host ended a session. The peer decides what to do from this.
pub mod bye {
    /// The host changed the PIN: ask the user for the new one.
    pub const PIN_CHANGED: &str = "pin_changed";
    /// The host stopped hosting: the session is over for good.
    pub const HOST_STOPPED: &str = "host_stopped";
    /// The same peer opened a newer session; this one is obsolete.
    pub const REPLACED: &str = "replaced";
    /// The host stopped hearing from the peer.
    pub const TIMEOUT: &str = "timeout";
}

/// Upload metadata travels in headers so the body can be the raw file.
pub mod headers {
    pub const MTIME: &str = "x-reptile-mtime";
    pub const SIZE: &str = "x-reptile-size";
    pub const BASE_SIZE: &str = "x-reptile-base-size";
    pub const BASE_MTIME: &str = "x-reptile-base-mtime";
}

/// Heartbeats and silence timeouts, in milliseconds.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// Host -> peer heartbeat line on the stream.
    pub stream_heartbeat_ms: u64,
    /// A peer that heard nothing for this long treats the stream as dead.
    pub stream_silence_ms: u64,
    /// Peer -> host heartbeat request.
    pub peer_heartbeat_ms: u64,
    /// A host that heard nothing from its peer for this long ends the session.
    pub peer_silence_ms: u64,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            stream_heartbeat_ms: 5000,
            stream_silence_ms: 16_000,
            peer_heartbeat_ms: 5000,
            peer_silence_ms: 20_000,
        }
    }
}
