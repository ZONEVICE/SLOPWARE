//! HTTP/1.1 message framing, shared by the server and the client: heads,
//! headers, and bodies delimited by Content-Length, chunked encoding or the
//! end of the connection.

use std::io::{self, BufRead, Read, Write};

/// Header names are stored lowercase; values as received.
#[derive(Debug, Clone, Default)]
pub struct Headers(Vec<(String, String)>);

impl Headers {
    pub fn new() -> Headers {
        Headers(Vec::new())
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    pub fn push(&mut self, name: &str, value: &str) {
        self.0.push((name.to_ascii_lowercase(), value.to_string()));
    }

    pub fn iter(&self) -> impl Iterator<Item = &(String, String)> {
        self.0.iter()
    }

    /// True when a comma-separated header (Connection, Transfer-Encoding)
    /// contains `token`, case-insensitively.
    pub fn has_token(&self, name: &str, token: &str) -> bool {
        self.0
            .iter()
            .filter(|(key, _)| key == name)
            .any(|(_, value)| value.split(',').any(|part| part.trim().eq_ignore_ascii_case(token)))
    }
}

/// Read one CRLF (or LF) terminated line, without the terminator. None on a
/// clean end of stream before any byte.
pub fn read_line(reader: &mut dyn BufRead, limit: usize) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed mid-line"));
        }
        if let Some(position) = available.iter().position(|b| *b == b'\n') {
            line.extend_from_slice(&available[..position]);
            reader.consume(position + 1);
            break;
        }
        let length = available.len();
        line.extend_from_slice(available);
        reader.consume(length);
        if line.len() > limit {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "header line too long"));
        }
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    if line.len() > limit {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "header line too long"));
    }
    String::from_utf8(line).map(Some).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "header is not UTF-8"))
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

/// Header lines until the empty line.
fn read_headers(reader: &mut dyn BufRead, limit: usize) -> io::Result<Headers> {
    let mut headers = Headers::new();
    let mut total = 0;
    loop {
        let line = read_line(reader, limit)?
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed in headers"))?;
        if line.is_empty() {
            return Ok(headers);
        }
        total += line.len();
        if total > limit || headers.0.len() >= 200 {
            return Err(invalid("too many headers"));
        }
        let (name, value) = line.split_once(':').ok_or_else(|| invalid("malformed header"))?;
        if name.is_empty() || name.bytes().any(|b| b <= b' ' || b >= 0x7f) {
            return Err(invalid("malformed header name"));
        }
        headers.push(name, value.trim());
    }
}

#[derive(Debug)]
pub struct RequestHead {
    pub method: String,
    pub target: String,
    /// HTTP/1.1 (true) or 1.0.
    pub http11: bool,
    pub headers: Headers,
}

/// Read a request head. None when the connection ended cleanly first.
pub fn read_request_head(reader: &mut dyn BufRead, limit: usize) -> io::Result<Option<RequestHead>> {
    // Tolerate stray empty lines between keep-alive requests.
    let line = loop {
        match read_line(reader, limit)? {
            None => return Ok(None),
            Some(line) if line.is_empty() => continue,
            Some(line) => break line,
        }
    };
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(invalid("malformed request line"));
    };
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_uppercase()) || !target.starts_with('/') && target != "*"
    {
        return Err(invalid("malformed request line"));
    }
    let http11 = match version {
        "HTTP/1.1" => true,
        "HTTP/1.0" => false,
        _ => return Err(invalid("unsupported HTTP version")),
    };
    let headers = read_headers(reader, limit)?;
    Ok(Some(RequestHead { method: method.to_string(), target: target.to_string(), http11, headers }))
}

#[derive(Debug)]
pub struct ResponseHead {
    pub status: u16,
    pub http11: bool,
    pub headers: Headers,
}

pub fn read_response_head(reader: &mut dyn BufRead, limit: usize) -> io::Result<ResponseHead> {
    let line = read_line(reader, limit)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed before a response"))?;
    let mut parts = line.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    let status = parts.next().and_then(|s| s.parse::<u16>().ok()).ok_or_else(|| invalid("malformed status line"))?;
    if !version.starts_with("HTTP/1.") {
        return Err(invalid("not an HTTP response"));
    }
    let headers = read_headers(reader, limit)?;
    Ok(ResponseHead { status, http11: version == "HTTP/1.1", headers })
}

/// How a body is delimited.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framing {
    Length(u64),
    Chunked,
    UntilClose,
}

/// The framing of a message body from its headers. Requests without either
/// header have no body; responses read until the connection closes.
pub fn framing(headers: &Headers, is_request: bool) -> io::Result<Framing> {
    if headers.get("transfer-encoding").is_some() {
        if headers.has_token("transfer-encoding", "chunked") {
            return Ok(Framing::Chunked);
        }
        return Err(invalid("unsupported transfer encoding"));
    }
    match headers.get("content-length") {
        Some(value) => {
            value.trim().parse::<u64>().map(Framing::Length).map_err(|_| invalid("malformed Content-Length"))
        }
        None if is_request => Ok(Framing::Length(0)),
        None => Ok(Framing::UntilClose),
    }
}

/// Body decoding state over a buffered reader.
#[derive(Debug)]
pub struct BodyState {
    pub framing: Framing,
    remaining: u64,
    chunk_left: u64,
    pub done: bool,
}

impl BodyState {
    pub fn new(framing: Framing) -> BodyState {
        let remaining = if let Framing::Length(length) = framing { length } else { 0 };
        BodyState { framing, remaining, chunk_left: 0, done: matches!(framing, Framing::Length(0)) }
    }

    /// Read decoded body bytes into `buffer`; 0 at the end of the body.
    pub fn read(&mut self, reader: &mut dyn BufRead, buffer: &mut [u8]) -> io::Result<usize> {
        if self.done || buffer.is_empty() {
            return Ok(0);
        }
        match self.framing {
            Framing::Length(_) => {
                let wanted = (buffer.len() as u64).min(self.remaining) as usize;
                let read = reader.read(&mut buffer[..wanted])?;
                if read == 0 {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed mid-body"));
                }
                self.remaining -= read as u64;
                if self.remaining == 0 {
                    self.done = true;
                }
                Ok(read)
            }
            Framing::UntilClose => {
                let read = reader.read(buffer)?;
                if read == 0 {
                    self.done = true;
                }
                Ok(read)
            }
            Framing::Chunked => {
                if self.chunk_left == 0 {
                    let line = read_line(reader, 4096)?
                        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed mid-chunk"))?;
                    let size_text = line.split(';').next().unwrap_or("").trim();
                    let size = u64::from_str_radix(size_text, 16).map_err(|_| invalid("malformed chunk size"))?;
                    if size == 0 {
                        // Trailers, then the final empty line.
                        while let Some(trailer) = read_line(reader, 8192)? {
                            if trailer.is_empty() {
                                break;
                            }
                        }
                        self.done = true;
                        return Ok(0);
                    }
                    self.chunk_left = size;
                }
                let wanted = (buffer.len() as u64).min(self.chunk_left) as usize;
                let read = reader.read(&mut buffer[..wanted])?;
                if read == 0 {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed mid-chunk"));
                }
                self.chunk_left -= read as u64;
                if self.chunk_left == 0 {
                    // The CRLF after the chunk data.
                    read_line(reader, 16)?;
                }
                Ok(read)
            }
        }
    }

    /// Read and discard what is left, up to `limit` bytes. True when the body
    /// was consumed completely.
    pub fn drain(&mut self, reader: &mut dyn BufRead, limit: u64) -> bool {
        let mut buffer = [0u8; 16 * 1024];
        let mut total = 0u64;
        while !self.done {
            match self.read(reader, &mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    total += read as u64;
                    if total > limit {
                        return false;
                    }
                }
                Err(_) => return false,
            }
        }
        self.done
    }
}

/// Writes a chunked body.
pub struct ChunkedWriter<'a> {
    pub inner: &'a mut dyn Write,
}

impl ChunkedWriter<'_> {
    pub fn chunk(&mut self, data: &[u8]) -> io::Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        let mut frame = Vec::with_capacity(data.len() + 16);
        frame.extend_from_slice(format!("{:x}\r\n", data.len()).as_bytes());
        frame.extend_from_slice(data);
        frame.extend_from_slice(b"\r\n");
        self.inner.write_all(&frame)?;
        self.inner.flush()
    }

    pub fn finish(&mut self) -> io::Result<()> {
        self.inner.write_all(b"0\r\n\r\n")?;
        self.inner.flush()
    }
}

/// The reason phrase of the statuses Reptile uses.
pub fn reason(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Unknown",
    }
}

/// Read a whole body into memory, refusing more than `limit` bytes.
pub fn read_to_limit(reader: &mut dyn Read, limit: usize) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(out);
        }
        if out.len() + read > limit {
            return Err(io::Error::new(io::ErrorKind::OutOfMemory, "body too large"));
        }
        out.extend_from_slice(&buffer[..read]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_a_request_and_a_chunked_body() {
        let raw = b"POST /api/x?y=1 HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\n\r\nGET / HTTP/1.1\r\n\r\n";
        let mut reader = Cursor::new(&raw[..]);
        let head = read_request_head(&mut reader, 8192).unwrap().unwrap();
        assert_eq!(head.method, "POST");
        assert_eq!(head.target, "/api/x?y=1");
        assert_eq!(head.headers.get("host"), Some("a"));
        let mut body = BodyState::new(framing(&head.headers, true).unwrap());
        let mut out = Vec::new();
        let mut buffer = [0u8; 3];
        loop {
            let read = body.read(&mut reader, &mut buffer).unwrap();
            if read == 0 {
                break;
            }
            out.extend_from_slice(&buffer[..read]);
        }
        assert_eq!(out, b"hello world");
        let next = read_request_head(&mut reader, 8192).unwrap().unwrap();
        assert_eq!(next.method, "GET");
        assert!(read_request_head(&mut reader, 8192).unwrap().is_none());
    }

    #[test]
    fn writes_chunks_and_parses_responses() {
        let mut sink = Vec::new();
        {
            let mut writer = ChunkedWriter { inner: &mut sink };
            writer.chunk(b"abc").unwrap();
            writer.finish().unwrap();
        }
        assert_eq!(sink, b"3\r\nabc\r\n0\r\n\r\n");
        let mut reader = Cursor::new(&b"HTTP/1.1 409 Conflict\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"[..]);
        let head = read_response_head(&mut reader, 8192).unwrap();
        assert_eq!(head.status, 409);
        assert!(head.headers.has_token("connection", "close"));
        assert_eq!(framing(&head.headers, false).unwrap(), Framing::Length(2));
        assert!(read_request_head(&mut Cursor::new(&b"\x16\x03\x01\x02\x00"[..]), 8192).is_err());
    }
}
