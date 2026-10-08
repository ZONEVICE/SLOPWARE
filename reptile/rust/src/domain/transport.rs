//! The transports the domain needs, as contracts.
//!
//! The domain never imports HTTP. The composition root (`app`) injects two
//! things: a factory of peer clients (the syncing side's view of a host) and a
//! discovery probe. That is what keeps the services testable and a second
//! transport possible.

use crate::domain::errors::AppError;
use crate::fs::entry::State;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// A failed request: transport error, timeout, or an error status from the peer.
#[derive(Debug, Clone)]
pub struct PeerError {
    /// HTTP status, or 0 when the request never got a response.
    pub status: u16,
    /// The peer's error code, or a transport code such as ECONNREFUSED.
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl PeerError {
    pub fn new(code: &str, message: impl Into<String>) -> PeerError {
        PeerError { status: 0, code: code.to_string(), message: message.into(), details: None }
    }
}

impl std::fmt::Display for PeerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

pub type PeerResult<T> = Result<T, PeerError>;

/// Turn a peer error into what this instance's user is told.
pub fn peer_error(error: &PeerError, fallback: &str) -> AppError {
    if error.status > 0 {
        let code = if error.code.is_empty() { "peer_error" } else { &error.code };
        let status = if error.status >= 500 { 502 } else { error.status };
        let mut app = AppError::new(code, error.message.clone(), status);
        app.details = error.details.clone();
        return app;
    }
    const UNREACHABLE: &[&str] = &["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ECONNRESET", "EPIPE"];
    if UNREACHABLE.contains(&error.code.as_str()) {
        return AppError::new("unreachable", fallback, 502);
    }
    let code = if error.code.is_empty() { "peer_error" } else { &error.code };
    let message = if error.message.is_empty() { fallback.to_string() } else { error.message.clone() };
    AppError::new(code, message, 502)
}

/// A downloaded file, streamed.
pub struct Download {
    pub body: Box<dyn Read + Send>,
    pub size: u64,
    pub mtime_ms: i64,
}

/// The host -> peer stream, already open.
pub trait StreamHandle: Send + Sync {
    fn close(&self);
}

pub type OnMessage = Box<dyn FnMut(Value) + Send>;
pub type OnClose = Box<dyn FnOnce(Option<PeerError>) + Send>;

/// The syncing side's client for the host's peer API.
pub trait PeerApi: Send + Sync {
    fn address(&self) -> &str;
    fn port(&self) -> u16;
    fn protocol(&self) -> &str;
    fn token(&self) -> Option<String>;
    fn set_token(&self, token: Option<String>);
    /// `GET /api/ping`.
    fn ping(&self) -> PeerResult<Value>;
    /// Open a session with the PIN; pins the host's certificate.
    fn connect(&self, pin: &str, local_path: &str) -> PeerResult<Value>;
    /// Open the event stream. `on_message` runs on the stream's own thread.
    fn open_stream(&self, on_message: OnMessage, on_close: OnClose) -> PeerResult<Arc<dyn StreamHandle>>;
    fn manifest(&self) -> PeerResult<Value>;
    fn hashes(&self, paths: &[String]) -> PeerResult<HashMap<String, String>>;
    fn download(&self, path: &str) -> PeerResult<Download>;
    fn upload(&self, path: &str, absolute: &Path, size: u64, mtime_ms: i64, base: Option<&State>) -> PeerResult<Value>;
    /// Apply non-content operations on the host, in order.
    fn ops(&self, list: &[Value]) -> PeerResult<Vec<Value>>;
    fn heartbeat(&self, report: &Value) -> PeerResult<()>;
    /// Leave the session on purpose. Best effort.
    fn disconnect(&self) -> PeerResult<()>;
    /// Release connections.
    fn close(&self);
}

pub type PeerFactory = Arc<dyn Fn(&str, u16, &'static str) -> Arc<dyn PeerApi> + Send + Sync>;

#[derive(Clone)]
pub struct ProbeOptions {
    pub host: String,
    pub port: u16,
    /// Tried first.
    pub prefer_protocol: String,
    pub connect_timeout_ms: u64,
    pub request_timeout_ms: u64,
    /// Go straight to HTTP (known instances).
    pub skip_tcp_check: bool,
    pub cancelled: Option<Arc<AtomicBool>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeStatus {
    Found,
    Closed,
    Unreachable,
    NotReptile,
}

#[derive(Clone, Debug)]
pub struct ProbeResult {
    pub status: ProbeStatus,
    /// The ping body plus `address`, `port` and `fingerprint`.
    pub info: Option<Value>,
    /// A machine answered at this address, even if nothing listens on the port.
    pub reachable: bool,
}

pub type Probe = Arc<dyn Fn(&ProbeOptions) -> ProbeResult + Send + Sync>;
