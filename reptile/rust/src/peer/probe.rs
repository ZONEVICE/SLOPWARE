//! Discovery probe: is there a Reptile instance (Rust or Node.js) at this
//! address and port, and which protocol does it speak?
//!
//! Step 1 is a bare TCP connect with a short timeout: on a LAN a closed port
//! answers at once with a reset, and an address with nobody behind it simply
//! times out, so most of a sweep costs one SYN per target.
//!
//! Step 2, only for open ports, is `GET /api/ping`, first over this
//! instance's own protocol and then over the other one: an instance of the
//! other protocol must still be FOUND so that the list can show it as
//! incompatible.

use crate::domain::protocol::paths;
use crate::domain::transport::{PeerError, ProbeOptions, ProbeResult, ProbeStatus};
use crate::http::client::{request_json, Options, Target};
use serde_json::{json, Value};
use std::io;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::Ordering;
use std::time::Duration;

#[derive(Debug, PartialEq, Eq)]
pub enum Tcp {
    Open,
    Closed,
    Timeout,
    Unreachable,
}

/// Try to open a TCP connection.
pub fn tcp_check(host: &str, port: u16, timeout_ms: u64) -> Tcp {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let Ok(mut addresses) = (host, port).to_socket_addrs() else { return Tcp::Unreachable };
    let Some(address) = addresses.next() else { return Tcp::Unreachable };
    match TcpStream::connect_timeout(&address, Duration::from_millis(timeout_ms.max(1))) {
        Ok(_) => Tcp::Open,
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => Tcp::Closed,
        Err(error) if matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock) => Tcp::Timeout,
        Err(_) => Tcp::Unreachable,
    }
}

/// A ping answer that is clearly Reptile; anything else is ignored.
pub fn is_reptile_ping(value: &Value) -> bool {
    value.get("app").and_then(Value::as_str) == Some("reptile")
        && value.get("uuid").map(Value::is_string).unwrap_or(false)
        && matches!(value.get("protocol").and_then(Value::as_str), Some("http" | "https"))
}

/// `GET /api/ping` over one protocol.
pub fn ping(host: &str, port: u16, protocol: &str, timeout_ms: u64) -> Result<Value, PeerError> {
    let target = Target::new(protocol, host, port);
    let (mut value, fingerprint) = request_json(&target, Options::get(paths::PING, timeout_ms), 64 * 1024)?;
    if !is_reptile_ping(&value) {
        return Err(PeerError::new("not_reptile", "Something answered, but it is not Reptile."));
    }
    value["fingerprint"] = json!(fingerprint);
    Ok(value)
}

/// Errors after which the other protocol is worth a try: HTTP spoken to a TLS
/// port gets reset; TLS spoken to an HTTP port fails the handshake.
fn suggests_other_protocol(code: &str) -> bool {
    !matches!(code, "ECONNREFUSED" | "EHOSTUNREACH" | "ENETUNREACH" | "ETIMEDOUT" | "ABORT_ERR" | "not_reptile")
}

/// Probe one address and port.
pub fn probe(options: &ProbeOptions) -> ProbeResult {
    let aborted = || options.cancelled.as_ref().map(|c| c.load(Ordering::SeqCst)).unwrap_or(false);
    if !options.skip_tcp_check {
        match tcp_check(&options.host, options.port, options.connect_timeout_ms) {
            Tcp::Open => {}
            Tcp::Closed => return ProbeResult { status: ProbeStatus::Closed, info: None, reachable: true },
            _ => return ProbeResult { status: ProbeStatus::Unreachable, info: None, reachable: false },
        }
    }
    let order: [&str; 2] = if options.prefer_protocol == "https" { ["https", "http"] } else { ["http", "https"] };
    let mut last: Option<PeerError> = None;
    for protocol in order {
        if aborted() {
            last = Some(PeerError::new("ABORT_ERR", "Request aborted."));
            break;
        }
        match ping(&options.host, options.port, protocol, options.request_timeout_ms) {
            Ok(mut info) => {
                let port = info.get("port").and_then(Value::as_u64).filter(|p| *p > 0).unwrap_or(options.port as u64);
                info["address"] = json!(options.host);
                info["port"] = json!(port);
                return ProbeResult { status: ProbeStatus::Found, info: Some(info), reachable: true };
            }
            Err(error) => {
                let retry = suggests_other_protocol(&error.code);
                last = Some(error);
                if !retry {
                    break;
                }
            }
        }
    }
    match last.map(|e| e.code).as_deref() {
        Some("ECONNREFUSED") => ProbeResult { status: ProbeStatus::Closed, info: None, reachable: true },
        Some("ETIMEDOUT") | Some("EHOSTUNREACH") => {
            ProbeResult { status: ProbeStatus::Unreachable, info: None, reachable: false }
        }
        _ => ProbeResult { status: ProbeStatus::NotReptile, info: None, reachable: true },
    }
}
