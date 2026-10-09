//! HTTP/1.1 response building and writing.
//!
//! Small, allocation-light responses with optional `ETag`/`Cache-Control`, so
//! reloading the app over a slow Bluetooth PAN link only re-sends assets that
//! actually changed.

use std::io::{self, Write};

pub struct Response {
    pub status: u16,
    pub reason: &'static str,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn new(status: u16, reason: &'static str) -> Response {
        Response {
            status,
            reason,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Response {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    pub fn with_body(mut self, body: Vec<u8>) -> Response {
        self.body = body;
        self
    }

    // --- Common constructors -------------------------------------------------

    pub fn text(status: u16, reason: &'static str, body: &str) -> Response {
        Response::new(status, reason)
            .with_header("Content-Type", "text/plain; charset=utf-8")
            .with_body(body.as_bytes().to_vec())
    }

    pub fn json(status: u16, reason: &'static str, body: String) -> Response {
        Response::new(status, reason)
            .with_header("Content-Type", "application/json; charset=utf-8")
            .with_header("Cache-Control", "no-store")
            .with_body(body.into_bytes())
    }

    pub fn ok_json(body: String) -> Response {
        Response::json(200, "OK", body)
    }

    pub fn not_found() -> Response {
        Response::text(404, "Not Found", "not found")
    }

    pub fn bad_request(msg: &str) -> Response {
        Response::text(400, "Bad Request", msg)
    }

    pub fn unauthorized() -> Response {
        Response::json(
            401,
            "Unauthorized",
            "{\"error\":\"unauthorized\"}".to_string(),
        )
    }

    pub fn forbidden(msg: &str) -> Response {
        Response::json(403, "Forbidden", format!("{{\"error\":{:?}}}", msg))
    }

    pub fn too_many() -> Response {
        Response::json(429, "Too Many Requests", "{\"error\":\"locked\"}".to_string())
    }

    /// A static asset with a strong `ETag` and immutable caching.
    pub fn asset(content_type: &str, etag: &str, body: Vec<u8>) -> Response {
        Response::new(200, "OK")
            .with_header("Content-Type", content_type)
            .with_header("ETag", etag)
            .with_header("Cache-Control", "no-cache")
            .with_body(body)
    }

    /// A 304 for a cache hit.
    pub fn not_modified(etag: &str) -> Response {
        Response::new(304, "Not Modified").with_header("ETag", etag)
    }

    /// Serialize and write the whole response. Always sends `Content-Length`
    /// and `Connection: keep-alive` so the client can reuse the socket.
    pub fn write_to<W: Write>(&self, w: &mut W) -> io::Result<()> {
        let mut head = format!("HTTP/1.1 {} {}\r\n", self.status, self.reason);
        let mut has_type = false;
        for (name, value) in &self.headers {
            if name.eq_ignore_ascii_case("content-type") {
                has_type = true;
            }
            head.push_str(name);
            head.push_str(": ");
            head.push_str(value);
            head.push_str("\r\n");
        }
        if !has_type && !self.body.is_empty() {
            head.push_str("Content-Type: application/octet-stream\r\n");
        }
        head.push_str(&format!("Content-Length: {}\r\n", self.body.len()));
        head.push_str("Connection: keep-alive\r\n");
        head.push_str("\r\n");
        w.write_all(head.as_bytes())?;
        if !self.body.is_empty() {
            w.write_all(&self.body)?;
        }
        w.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_status_and_length() {
        let resp = Response::ok_json("{\"a\":1}".to_string());
        let mut out = Vec::new();
        resp.write_to(&mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(text.contains("Content-Length: 7\r\n"));
        assert!(text.contains("application/json"));
        assert!(text.ends_with("{\"a\":1}"));
    }

    #[test]
    fn not_found_has_body() {
        let resp = Response::not_found();
        assert_eq!(resp.status, 404);
        assert_eq!(resp.body, b"not found");
    }
}
