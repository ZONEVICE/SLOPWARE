//! Minimal HTTP/1.1 request parsing.
//!
//! Enough of HTTP to serve a single-page app and a WebSocket upgrade: the
//! request line, headers, an optional `Content-Length` body, and percent-decoded
//! path and query. No chunked request bodies (the client never sends one).

use std::collections::HashMap;
use std::io::{self, BufRead};

/// Hard cap on a request body (4 MiB) — config imports are the largest thing
/// posted and are far smaller.
const MAX_BODY: usize = 4 * 1024 * 1024;

#[derive(Debug)]
pub struct Request {
    pub method: String,
    pub target: String,
    pub path: String,
    pub query: HashMap<String, String>,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    /// Case-insensitive header lookup.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn query_param(&self, name: &str) -> Option<&str> {
        self.query.get(name).map(|s| s.as_str())
    }

    /// True when this request is a WebSocket upgrade.
    pub fn is_websocket_upgrade(&self) -> bool {
        self.header("upgrade")
            .map(|v| v.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
            && self
                .header("connection")
                .map(|v| v.to_ascii_lowercase().contains("upgrade"))
                .unwrap_or(false)
    }

    pub fn body_str(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Read and parse one request from a buffered stream. Returns `Ok(None)` on a
/// clean EOF between requests (keep-alive connection closed by the peer).
pub fn read_request<R: BufRead>(reader: &mut R) -> io::Result<Option<Request>> {
    let mut request_line = String::new();
    let n = reader.read_line(&mut request_line)?;
    if n == 0 {
        return Ok(None); // peer closed cleanly
    }
    let request_line = request_line.trim_end();
    if request_line.is_empty() {
        return Ok(None);
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    if method.is_empty() || target.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "malformed request line",
        ));
    }

    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            break;
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }

    // Body, if a Content-Length is present.
    let content_length = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);

    let body = if content_length > 0 {
        if content_length > MAX_BODY {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request body too large",
            ));
        }
        let mut buf = vec![0u8; content_length];
        reader.read_exact(&mut buf)?;
        buf
    } else {
        Vec::new()
    };

    let (path, query) = split_target(&target);

    Ok(Some(Request {
        method,
        target,
        path,
        query,
        headers,
        body,
    }))
}

/// Split a request target into a decoded path and a map of decoded query
/// parameters.
fn split_target(target: &str) -> (String, HashMap<String, String>) {
    let (raw_path, raw_query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    let path = percent_decode(raw_path);
    let mut query = HashMap::new();
    for pair in raw_query.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        query.insert(percent_decode_plus(k), percent_decode_plus(v));
    }
    (path, query)
}

/// Percent-decode a path component (does not treat `+` as space).
pub fn percent_decode(s: &str) -> String {
    decode_inner(s, false)
}

/// Percent-decode a query component (`+` becomes space).
pub fn percent_decode_plus(s: &str) -> String {
    decode_inner(s, true)
}

fn decode_inner(s: &str, plus_is_space: bool) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let h = hex_val(bytes[i + 1]);
                let l = hex_val(bytes[i + 2]);
                if let (Some(h), Some(l)) = (h, l) {
                    out.push(h * 16 + l);
                    i += 3;
                } else {
                    out.push(b'%');
                    i += 1;
                }
            }
            b'+' if plus_is_space => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    fn parse(raw: &str) -> Request {
        let mut r = BufReader::new(raw.as_bytes());
        read_request(&mut r).unwrap().unwrap()
    }

    #[test]
    fn parses_get_with_query() {
        let req = parse("GET /api/x?tab=mouse&theme=gorbino HTTP/1.1\r\nHost: h\r\n\r\n");
        assert_eq!(req.method, "GET");
        assert_eq!(req.path, "/api/x");
        assert_eq!(req.query_param("tab"), Some("mouse"));
        assert_eq!(req.query_param("theme"), Some("gorbino"));
        assert_eq!(req.header("host"), Some("h"));
    }

    #[test]
    fn parses_post_body() {
        let req = parse("POST /p HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello");
        assert_eq!(req.method, "POST");
        assert_eq!(req.body_str(), "hello");
    }

    #[test]
    fn detects_websocket_upgrade() {
        let req = parse("GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        assert!(req.is_websocket_upgrade());
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("/a%20b"), "/a b");
        assert_eq!(percent_decode_plus("a+b%2Bc"), "a b+c");
        assert_eq!(percent_decode("%C3%B1"), "ñ");
    }
}
