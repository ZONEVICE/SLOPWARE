//! Binding the listener: a busy port is not an error.
//!
//! Tendril starts at the requested port (6060 by default) and, when it is
//! taken, tries the next one, up to 64 ports. Only "address in use" moves on:
//! a bad address or a permission problem is a real configuration error and is
//! reported at once. Windows reports a port held with `SO_EXCLUSIVEADDRUSE`
//! or reserved by Hyper-V as "access denied", so there that also moves on.
//! Port 0 is passed through untouched ("any free port"). The caller prints the
//! port actually bound, from the returned listener.

use std::io;
use std::net::{IpAddr, SocketAddr, TcpListener};

/// Ports tried at most.
pub const ATTEMPTS: u16 = 64;

/// Binds `ip` at the first free port from `preferred` on.
pub fn bind(ip: IpAddr, preferred: u16) -> io::Result<TcpListener> {
    if preferred == 0 {
        return TcpListener::bind(SocketAddr::new(ip, 0));
    }
    let last = preferred.saturating_add(ATTEMPTS - 1);
    for port in preferred..=last {
        match TcpListener::bind(SocketAddr::new(ip, port)) {
            Ok(listener) => return Ok(listener),
            Err(err) if is_taken(&err) => continue,
            Err(err) => return Err(err),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AddrInUse,
        format!("no free port between {preferred} and {last}; choose another one with --port <n>"),
    ))
}

fn is_taken(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::AddrInUse || (cfg!(windows) && err.kind() == io::ErrorKind::PermissionDenied)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL: IpAddr = IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);

    #[test]
    fn walks_past_a_busy_port() {
        let first = bind(LOCAL, 0).unwrap();
        let busy = first.local_addr().unwrap().port();
        if busy == u16::MAX {
            return;
        }
        let second = bind(LOCAL, busy).unwrap();
        let got = second.local_addr().unwrap().port();
        assert!(got > busy && got < busy.saturating_add(ATTEMPTS), "{busy} -> {got}");
    }

    #[test]
    fn port_zero_means_any() {
        let listener = bind(LOCAL, 0).unwrap();
        assert_ne!(listener.local_addr().unwrap().port(), 0);
    }

    #[test]
    fn an_address_that_is_not_ours_is_an_error_not_a_walk() {
        // TEST-NET-1 is never assigned to a local interface.
        let err = bind("192.0.2.1".parse().unwrap(), 6060).unwrap_err();
        assert_ne!(err.kind(), io::ErrorKind::AddrInUse);
    }
}
