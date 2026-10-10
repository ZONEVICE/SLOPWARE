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
use std::net::ToSocketAddrs;
use std::sync::atomic::Ordering;

#[derive(Debug, PartialEq, Eq)]
pub enum Tcp {
    Open,
    Closed,
    Timeout,
    Unreachable,
}

/// Try to open a TCP connection.
#[cfg(not(windows))]
pub fn tcp_check(host: &str, port: u16, timeout_ms: u64) -> Tcp {
    use std::net::TcpStream;
    use std::time::Duration;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let Ok(mut addresses) = (host, port).to_socket_addrs() else { return Tcp::Unreachable };
    let Some(address) = addresses.next() else { return Tcp::Unreachable };
    match TcpStream::connect_timeout(&address, Duration::from_millis(timeout_ms.max(1))) {
        Ok(_) => Tcp::Open,
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => Tcp::Closed,
        Err(error) if matches!(error.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock) => {
            Tcp::Timeout
        }
        Err(_) => Tcp::Unreachable,
    }
}

/// Try to open a TCP connection (Windows).
///
/// A non-blocking `connect`, then `select` on the write and exception sets,
/// then `SO_ERROR`: a refusal (`WSAECONNREFUSED`) is `Closed`, as on Unix, and
/// silence is `Timeout`. On real Windows 10, `connect_timeout` reported a refused
/// connection as a timeout instead. Windows is also slow to refuse: it retries
/// the SYN after the reset, so a closed port took ~2 s to come back refused on
/// the test machine. Within a shorter timeout, such as the sweep's 700 ms, it
/// still looks like a silent host.
#[cfg(windows)]
pub fn tcp_check(host: &str, port: u16, timeout_ms: u64) -> Tcp {
    use std::net::SocketAddr;
    use std::sync::Once;
    use windows_sys::Win32::Networking::WinSock::{
        closesocket, connect, getsockopt, ioctlsocket, select, socket, WSAGetLastError, WSAStartup, ADDRESS_FAMILY,
        AF_INET, AF_INET6, FD_SET, FIONBIO, IN6_ADDR, IN6_ADDR_0, INVALID_SOCKET, IN_ADDR, IN_ADDR_0, IPPROTO_TCP,
        SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6, SOCKADDR_IN6_0, SOCKET_ERROR, SOCK_STREAM, SOL_SOCKET, SO_ERROR, TIMEVAL,
        WSADATA, WSAEWOULDBLOCK,
    };

    // Winsock is already up (the server uses std::net), but make sure, once.
    static WSA: Once = Once::new();
    WSA.call_once(|| {
        let mut data: WSADATA = unsafe { std::mem::zeroed() };
        // SAFETY: a valid WSADATA out-pointer; the extra startup ref is harmless.
        unsafe { WSAStartup(0x0202, &mut data) };
    });

    let host = host.trim_start_matches('[').trim_end_matches(']');
    let Ok(mut addresses) = (host, port).to_socket_addrs() else { return Tcp::Unreachable };
    let Some(address) = addresses.next() else { return Tcp::Unreachable };

    // Map a Winsock error code to our states, matching the Unix classification.
    let classify = |err: i32| -> Tcp {
        const WSAECONNREFUSED: i32 = 10061;
        const WSAETIMEDOUT: i32 = 10060;
        match err {
            WSAECONNREFUSED => Tcp::Closed,
            WSAETIMEDOUT => Tcp::Timeout,
            _ => Tcp::Unreachable,
        }
    };

    // SAFETY: a socket we create, drive and close; the sockaddr lives on the
    // stack through the connect that copies it, and lengths match the structs.
    unsafe {
        let family = if address.is_ipv4() { AF_INET } else { AF_INET6 };
        let sock = socket(family as i32, SOCK_STREAM, IPPROTO_TCP);
        if sock == INVALID_SOCKET {
            return Tcp::Unreachable;
        }
        let mut non_blocking: u32 = 1;
        ioctlsocket(sock, FIONBIO, &mut non_blocking);

        // Non-blocking connect; read the error immediately, as a later call (even
        // freeing memory) resets the thread's last-error and would hide WOULDBLOCK.
        let (rc, connect_err) = match address {
            SocketAddr::V4(v4) => {
                let raw = SOCKADDR_IN {
                    sin_family: AF_INET as ADDRESS_FAMILY,
                    sin_port: port.to_be(),
                    sin_addr: IN_ADDR { S_un: IN_ADDR_0 { S_addr: u32::from_ne_bytes(v4.ip().octets()) } },
                    sin_zero: [0; 8],
                };
                let rc = connect(sock, &raw as *const _ as *const SOCKADDR, std::mem::size_of::<SOCKADDR_IN>() as i32);
                (rc, WSAGetLastError())
            }
            SocketAddr::V6(v6) => {
                let raw = SOCKADDR_IN6 {
                    sin6_family: AF_INET6 as ADDRESS_FAMILY,
                    sin6_port: port.to_be(),
                    sin6_flowinfo: 0,
                    sin6_addr: IN6_ADDR { u: IN6_ADDR_0 { Byte: v6.ip().octets() } },
                    Anonymous: SOCKADDR_IN6_0 { sin6_scope_id: v6.scope_id() },
                };
                let rc = connect(sock, &raw as *const _ as *const SOCKADDR, std::mem::size_of::<SOCKADDR_IN6>() as i32);
                (rc, WSAGetLastError())
            }
        };

        let result = if rc == 0 {
            Tcp::Open // connected at once (a listening loopback port)
        } else if connect_err != WSAEWOULDBLOCK {
            classify(connect_err)
        } else {
            let mut writable: FD_SET = std::mem::zeroed();
            writable.fd_count = 1;
            writable.fd_array[0] = sock;
            let mut failed: FD_SET = std::mem::zeroed();
            failed.fd_count = 1;
            failed.fd_array[0] = sock;
            let timeout = TIMEVAL { tv_sec: (timeout_ms / 1000) as i32, tv_usec: ((timeout_ms % 1000) * 1000) as i32 };
            let ready = select(0, std::ptr::null_mut(), &mut writable, &mut failed, &timeout);
            if ready == 0 {
                Tcp::Timeout
            } else if ready == SOCKET_ERROR {
                Tcp::Unreachable
            } else {
                // Writable means connected; the exception set means it failed.
                let mut so_error: i32 = 0;
                let mut len = std::mem::size_of::<i32>() as i32;
                getsockopt(sock, SOL_SOCKET, SO_ERROR, &mut so_error as *mut i32 as *mut u8, &mut len);
                if so_error == 0 {
                    Tcp::Open
                } else {
                    classify(so_error)
                }
            }
        };
        closesocket(sock);
        result
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
