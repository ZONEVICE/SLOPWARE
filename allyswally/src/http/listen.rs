//! Port walk: bind the first free port at or after the preferred one.
//!
//! A repository-wide rule — a busy port is not an error. The server starts at
//! the preferred port and climbs on `AddrInUse` only, so launching a second
//! instance simply gives a second server on the next port. Other bind errors
//! (permission, bad address) are real and surface immediately.

use std::io;
use std::net::{Ipv4Addr, TcpListener};

/// How many ports to try before giving up.
const ATTEMPTS: u16 = 64;

/// Bind `0.0.0.0:<port>` starting at `preferred`. Returns the listener and the
/// port actually bound. Port 0 (any free port) is passed straight through.
pub fn bind(preferred: u16) -> io::Result<(TcpListener, u16)> {
    if preferred == 0 {
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))?;
        let port = listener.local_addr()?.port();
        return Ok((listener, port));
    }

    let mut last_err = None;
    for offset in 0..ATTEMPTS {
        let port = match preferred.checked_add(offset) {
            Some(p) => p,
            None => break,
        };
        match TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)) {
            Ok(listener) => return Ok((listener, port)),
            Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
                last_err = Some(e);
                continue;
            }
            // Permission denied, address unavailable: walking will not help.
            Err(e) => return Err(e),
        }
    }
    let last = preferred.saturating_add(ATTEMPTS - 1);
    Err(io::Error::new(
        io::ErrorKind::AddrInUse,
        format!(
            "no free port between {preferred} and {last} ({}). Pass a different port.",
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "unknown".into())
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binds_preferred_when_free() {
        // Port 0 always yields a free port.
        let (listener, port) = bind(0).unwrap();
        assert!(port > 0);
        drop(listener);
    }

    #[test]
    fn walks_past_a_busy_port() {
        // Hold a port, then ask for it: the walk should move to the next.
        let (held, port) = bind(0).unwrap();
        // Only meaningful for non-zero preferred ports; re-bind at `port`.
        let (next, next_port) = bind(port).unwrap();
        assert_ne!(port, next_port);
        assert!(next_port > port);
        drop(held);
        drop(next);
    }
}
