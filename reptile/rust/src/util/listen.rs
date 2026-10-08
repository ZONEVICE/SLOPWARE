//! Port selection: bind the first free port at or after the requested one.
//!
//! A busy port is not an error. If 55667 is taken the server tries 55668, then
//! 55669, and so on. This applies to an explicit `--port` too: `--port 8080`
//! means "start at 8080", not "8080 or nothing". Only "address in use"
//! triggers a retry; a privileged port or an address that is not on this
//! machine is a real configuration problem. Port 0 is passed straight through.

use crate::util::logger::Logger;
use std::io;
use std::net::TcpListener;

pub struct Bound {
    pub listener: TcpListener,
    pub port: u16,
}

pub fn listen_with_fallback(host: &str, port: u16, attempts: u32, logger: &Logger) -> io::Result<Bound> {
    let max = if port == 0 { 1 } else { attempts.max(1) };
    let mut candidate = port as u32;
    let mut tried = 0;
    while tried < max && candidate <= 65535 {
        match TcpListener::bind((host, candidate as u16)) {
            Ok(listener) => {
                let bound = listener.local_addr()?.port();
                if port != 0 && bound != port {
                    let skipped = bound - port;
                    logger.warn(format_args!(
                        "port {port} is already in use; listening on {bound} instead ({skipped} port{} busy)",
                        if skipped == 1 { " was" } else { "s were" }
                    ));
                }
                return Ok(Bound { listener, port: bound });
            }
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                logger.debug(format_args!("port {candidate} is in use, trying {}", candidate + 1));
                candidate += 1;
                tried += 1;
            }
            Err(error) => return Err(error),
        }
    }
    let searched = candidate.saturating_sub(1);
    Err(io::Error::new(
        io::ErrorKind::AddrInUse,
        format!(
            "No free port found: {port}{} are all in use. Pick another starting port with --port.",
            if searched > port as u32 { format!(" through {searched}") } else { String::new() }
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walks_past_a_busy_port() {
        let busy = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = busy.local_addr().unwrap().port();
        let bound = listen_with_fallback("127.0.0.1", port, 64, &Logger::silent()).unwrap();
        assert!(bound.port > port);
        let refused = listen_with_fallback("127.0.0.1", port, 1, &Logger::silent());
        assert_eq!(refused.err().unwrap().kind(), io::ErrorKind::AddrInUse);
        let any = listen_with_fallback("127.0.0.1", 0, 64, &Logger::silent()).unwrap();
        assert_ne!(any.port, 0);
    }
}
