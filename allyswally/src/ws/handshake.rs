//! The RFC 6455 opening handshake: deriving `Sec-WebSocket-Accept` from the
//! client's `Sec-WebSocket-Key`.

use crate::base64;
use crate::sha1::sha1;

/// The fixed GUID appended to the client key before hashing (RFC 6455 §4.2.2).
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Compute the `Sec-WebSocket-Accept` value for a given `Sec-WebSocket-Key`.
pub fn accept_key(client_key: &str) -> String {
    let combined = format!("{client_key}{WS_GUID}");
    base64::encode(&sha1(combined.as_bytes()))
}

/// Pull the `Sec-WebSocket-Key` value out of raw request headers, if present.
pub fn parse_key_header(headers: &str) -> Option<String> {
    for line in headers.lines() {
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("sec-websocket-key") {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The canonical example from RFC 6455 §1.3.
    #[test]
    fn rfc6455_example() {
        assert_eq!(
            accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn extracts_key_case_insensitively() {
        let headers = "GET /ws HTTP/1.1\r\nHost: x\r\nSec-WebSocket-Key: abc123==\r\n";
        assert_eq!(parse_key_header(headers).as_deref(), Some("abc123=="));
    }
}
