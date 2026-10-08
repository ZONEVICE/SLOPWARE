//! Outgoing HTTP(S) requests between instances.
//!
//! Hand-written for the same reasons as the Node.js implementation's
//! `httpRequest`: peers use self-signed certificates that must be accepted and
//! then pinned by fingerprint, and uploads use `Expect: 100-continue` (headers
//! first, the file only once the host agrees), so a refused or
//! already-present file costs one round trip instead of the whole file.
//!
//! Idle keep-alive connections are pooled per peer client and retired a
//! second before the server's `Keep-Alive: timeout` hint, like Node's agent.
//! A pooled connection that turns out to be closed is retried once on a
//! fresh one.

use crate::domain::transport::PeerError;
use crate::http::conn::Stream;
use crate::http::message::{framing, read_response_head, read_to_limit, BodyState, Framing, Headers};
use crate::http::tls::{client_config, peer_fingerprint, server_name};
use crate::util::threads::Locked;
use rustls::{ClientConnection, StreamOwned};
use serde_json::Value;
use std::fs::File;
use std::io::{self, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Target {
    pub protocol: String,
    pub host: String,
    pub port: u16,
}

impl Target {
    pub fn new(protocol: &str, host: &str, port: u16) -> Target {
        Target { protocol: protocol.to_string(), host: host.to_string(), port }
    }

    fn https(&self) -> bool {
        self.protocol == "https"
    }

    fn host_header(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

struct Connection {
    reader: BufReader<Stream>,
    fingerprint: Option<String>,
}

/// Idle keep-alive connections to one target.
#[derive(Default)]
pub struct Pool {
    idle: Mutex<Vec<(Instant, Connection)>>,
}

impl Pool {
    pub fn new() -> Arc<Pool> {
        Arc::new(Pool::default())
    }

    fn take(&self) -> Option<Connection> {
        let mut idle = self.idle.locked();
        while let Some((expires, connection)) = idle.pop() {
            if Instant::now() < expires && alive(connection.reader.get_ref()) && connection.reader.buffer().is_empty() {
                return Some(connection);
            }
        }
        None
    }

    fn give_back(&self, connection: Connection, keep_for: Duration) {
        let mut idle = self.idle.locked();
        if idle.len() < 16 {
            idle.push((Instant::now() + keep_for, connection));
        }
    }

    /// Close every idle connection.
    pub fn clear(&self) {
        for (_, connection) in self.idle.locked().drain(..) {
            connection.reader.get_ref().shutdown();
        }
    }
}

/// An idle connection the server already closed reads as end-of-stream.
fn alive(stream: &Stream) -> bool {
    let socket = stream.socket();
    if socket.set_nonblocking(true).is_err() {
        return false;
    }
    let mut byte = [0u8; 1];
    let alive = matches!(socket.peek(&mut byte), Err(ref error) if error.kind() == io::ErrorKind::WouldBlock);
    let _ = socket.set_nonblocking(false);
    alive
}

pub enum Body<'a> {
    None,
    Bytes(Vec<u8>),
    /// Exactly `length` bytes read from the start of the file: a file that
    /// grows during the upload must not overflow Content-Length.
    File {
        path: &'a Path,
        length: u64,
    },
}

pub struct Options<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub headers: Vec<(String, String)>,
    pub body: Body<'a>,
    /// Socket inactivity timeout (not a total deadline).
    pub timeout_ms: u64,
    pub expect_continue: bool,
    /// Expected certificate fingerprint.
    pub fingerprint: Option<String>,
    pub pool: Option<&'a Arc<Pool>>,
    pub cancelled: Option<&'a AtomicBool>,
}

impl<'a> Options<'a> {
    pub fn get(path: &'a str, timeout_ms: u64) -> Options<'a> {
        Options {
            method: "GET",
            path,
            headers: Vec::new(),
            body: Body::None,
            timeout_ms,
            expect_continue: false,
            fingerprint: None,
            pool: None,
            cancelled: None,
        }
    }

    pub fn post_json(path: &'a str, value: &Value, timeout_ms: u64) -> Options<'a> {
        let mut options = Options::get(path, timeout_ms);
        options.method = "POST";
        options.headers.push(("Content-Type".into(), "application/json".into()));
        options.body = Body::Bytes(value.to_string().into_bytes());
        options
    }
}

/// Map a transport error to the codes the rest of Reptile (and the Node.js
/// implementation's messages) use.
pub fn io_code(error: &io::Error) -> &'static str {
    use io::ErrorKind::*;
    match error.kind() {
        ConnectionRefused => "ECONNREFUSED",
        TimedOut | WouldBlock => "ETIMEDOUT",
        HostUnreachable => "EHOSTUNREACH",
        NetworkUnreachable => "ENETUNREACH",
        ConnectionReset | UnexpectedEof => "ECONNRESET",
        BrokenPipe => "EPIPE",
        ConnectionAborted => "ECONNABORTED",
        InvalidData => "EPROTO",
        _ => "request_failed",
    }
}

fn transport_error(target: &Target, error: &io::Error, timeout_ms: u64) -> PeerError {
    let code = io_code(error);
    let message = if code == "ETIMEDOUT" {
        format!("No answer from {}:{} within {timeout_ms} ms.", target.host, target.port)
    } else {
        format!("{error} ({}:{})", target.host, target.port)
    };
    PeerError::new(code, message)
}

fn resolve(target: &Target) -> io::Result<Vec<SocketAddr>> {
    let host = target.host.trim_start_matches('[').trim_end_matches(']');
    Ok((host, target.port).to_socket_addrs()?.collect())
}

/// Open a TCP (and TLS) connection.
fn connect(target: &Target, timeout_ms: u64) -> io::Result<Connection> {
    let timeout = Duration::from_millis(timeout_ms.max(1));
    let mut last = io::Error::new(io::ErrorKind::NotFound, "no address");
    let mut socket = None;
    for address in resolve(target)? {
        match TcpStream::connect_timeout(&address, timeout) {
            Ok(connected) => {
                socket = Some(connected);
                break;
            }
            Err(error) => last = error,
        }
    }
    let socket = socket.ok_or(last)?;
    let _ = socket.set_nodelay(true);
    socket.set_read_timeout(Some(timeout))?;
    socket.set_write_timeout(Some(timeout))?;
    if !target.https() {
        return Ok(Connection {
            reader: BufReader::with_capacity(64 * 1024, Stream::Plain(socket)),
            fingerprint: None,
        });
    }
    let host = target.host.trim_start_matches('[').trim_end_matches(']');
    let connection = ClientConnection::new(client_config(), server_name(host)).map_err(io::Error::other)?;
    let mut tls = StreamOwned::new(connection, socket);
    while tls.conn.is_handshaking() {
        tls.conn.complete_io(&mut tls.sock)?;
    }
    let fingerprint = peer_fingerprint(tls.conn.peer_certificates());
    Ok(Connection { reader: BufReader::with_capacity(64 * 1024, Stream::TlsClient(Box::new(tls))), fingerprint })
}

pub struct Response {
    pub status: u16,
    pub headers: Headers,
    pub fingerprint: Option<String>,
    body: ResponseBody,
}

/// A response body being read; a fully read keep-alive connection goes back
/// to its pool.
pub struct ResponseBody {
    connection: Option<Connection>,
    state: BodyState,
    reusable: bool,
    keep_for: Duration,
    pool: Option<Arc<Pool>>,
}

impl ResponseBody {
    fn finish(&mut self) {
        if !self.state.done {
            return;
        }
        if let (Some(connection), Some(pool), true) = (self.connection.take(), self.pool.as_ref(), self.reusable) {
            pool.give_back(connection, self.keep_for);
        }
    }

    /// A handle that can end the response from another thread.
    pub fn closer(&self) -> Option<TcpStream> {
        self.connection.as_ref().and_then(|c| c.reader.get_ref().closer())
    }
}

impl Read for ResponseBody {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let Some(connection) = self.connection.as_mut() else { return Ok(0) };
        let read = self.state.read(&mut connection.reader, buffer)?;
        if self.state.done {
            self.finish();
        }
        Ok(read)
    }
}

impl Drop for ResponseBody {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.take() {
            if !(self.state.done && self.reusable && self.pool.is_some()) {
                connection.reader.get_ref().shutdown();
            } else if let Some(pool) = &self.pool {
                pool.give_back(connection, self.keep_for);
            }
        }
    }
}

impl Response {
    pub fn into_body(self) -> ResponseBody {
        self.body
    }

    /// Read the whole body as JSON (`null` when empty).
    pub fn json(mut self, limit: usize) -> Result<Value, PeerError> {
        let raw = read_to_limit(&mut self.body, limit).map_err(|error| {
            if error.kind() == io::ErrorKind::OutOfMemory {
                PeerError::new("response_too_large", "Response is too large.")
            } else {
                PeerError::new(io_code(&error), error.to_string())
            }
        })?;
        if raw.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&raw).map_err(|_| PeerError {
            status: self.status,
            code: "bad_json".into(),
            message: "The peer sent malformed JSON.".into(),
            details: None,
        })
    }
}

fn keep_alive_hint(headers: &Headers) -> Duration {
    let seconds = headers
        .get("keep-alive")
        .and_then(|value| {
            value
                .split(',')
                .find_map(|part| part.trim().strip_prefix("timeout=").and_then(|t| t.trim().parse::<u64>().ok()))
        })
        .unwrap_or(5);
    Duration::from_millis(seconds.saturating_mul(1000).saturating_sub(1000).max(500))
}

enum Failure {
    /// Nothing reached the server's application: safe to retry.
    BeforeResponse(io::Error),
    Final(PeerError),
}

fn send(target: &Target, options: &Options<'_>, mut connection: Connection) -> Result<Response, Failure> {
    if let (Some(expected), Some(seen)) = (&options.fingerprint, &connection.fingerprint) {
        if expected != seen {
            connection.reader.get_ref().shutdown();
            return Err(Failure::Final(PeerError::new(
                "certificate_changed",
                "The peer presented a different certificate than when the session started.",
            )));
        }
    }
    connection.reader.get_ref().set_timeout(options.timeout_ms);
    let keep_alive = options.pool.is_some();
    let mut head = format!("{} {} HTTP/1.1\r\nHost: {}\r\n", options.method, options.path, target.host_header());
    if !options.headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("accept")) {
        head.push_str("Accept: application/json\r\n");
    }
    for (name, value) in &options.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    let length = match &options.body {
        Body::None => None,
        Body::Bytes(bytes) => Some(bytes.len() as u64),
        Body::File { length, .. } => Some(*length),
    };
    if let Some(length) = length {
        if !options.headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-length")) {
            head.push_str(&format!("Content-Length: {length}\r\n"));
        }
    }
    let expect = options.expect_continue && matches!(options.body, Body::File { .. });
    if expect {
        head.push_str("Expect: 100-continue\r\n");
    }
    head.push_str(if keep_alive { "Connection: keep-alive\r\n\r\n" } else { "Connection: close\r\n\r\n" });

    let file = match &options.body {
        Body::File { path, .. } => Some(File::open(path).map_err(|error| {
            Failure::Final(PeerError::new("local_read_failed", format!("Could not read the local file: {error}")))
        })?),
        _ => None,
    };

    let stream = connection.reader.get_mut();
    let mut message = head.into_bytes();
    if let Body::Bytes(bytes) = &options.body {
        message.extend_from_slice(bytes);
    }
    stream.write_all(&message).map_err(Failure::BeforeResponse)?;
    stream.flush().map_err(Failure::BeforeResponse)?;

    let mut body_sent = !expect;
    let send_file = |connection: &mut Connection, mut file: File, length: u64| -> Result<(), Failure> {
        let mut left = length;
        let mut buffer = vec![0u8; 256 * 1024];
        let stream = connection.reader.get_mut();
        while left > 0 {
            let wanted = (buffer.len() as u64).min(left) as usize;
            let read = file
                .read(&mut buffer[..wanted])
                .map_err(|e| Failure::Final(PeerError::new("local_read_failed", e.to_string())))?;
            if read == 0 {
                return Err(Failure::Final(PeerError::new(
                    "local_read_failed",
                    "The local file shrank during the upload.",
                )));
            }
            stream
                .write_all(&buffer[..read])
                .map_err(|e| Failure::Final(transport_error(target, &e, options.timeout_ms)))?;
            left -= read as u64;
        }
        stream.flush().map_err(|e| Failure::Final(transport_error(target, &e, options.timeout_ms)))
    };
    let mut file = file;
    if !expect {
        if let (Some(file), Body::File { length, .. }) = (file.take(), &options.body) {
            send_file(&mut connection, file, *length)?;
        }
    }

    let mut first_byte_seen = false;
    let response_head = loop {
        let head = match read_response_head(&mut connection.reader, 64 * 1024) {
            Ok(head) => head,
            // Nothing came back at all: a pooled connection the server had
            // already closed. Every request of the protocol tolerates being
            // repeated (and an upload waiting for 100 Continue sent no body).
            Err(error) if !first_byte_seen => return Err(Failure::BeforeResponse(error)),
            Err(error) => return Err(Failure::Final(transport_error(target, &error, options.timeout_ms))),
        };
        first_byte_seen = true;
        if head.status == 100 && expect && !body_sent {
            if let (Some(file), Body::File { length, .. }) = (file.take(), &options.body) {
                send_file(&mut connection, file, *length)?;
            }
            body_sent = true;
            continue;
        }
        if (100..200).contains(&head.status) {
            continue;
        }
        break head;
    };

    let mut reusable = keep_alive && response_head.http11 && !response_head.headers.has_token("connection", "close");
    if expect && !body_sent {
        // The server answered without asking for the body: never send it,
        // and never reuse a connection it may still expect a body on.
        reusable = false;
    }
    let body_framing = if options.method == "HEAD" || matches!(response_head.status, 204 | 304) {
        Framing::Length(0)
    } else {
        framing(&response_head.headers, false).map_err(|e| Failure::Final(PeerError::new("EPROTO", e.to_string())))?
    };
    if body_framing == Framing::UntilClose {
        reusable = false;
    }
    let keep_for = keep_alive_hint(&response_head.headers);
    let fingerprint = connection.fingerprint.clone();
    let mut body = ResponseBody {
        connection: Some(connection),
        state: BodyState::new(body_framing),
        reusable,
        keep_for,
        pool: options.pool.cloned(),
    };
    body.finish();
    let response = Response { status: response_head.status, headers: response_head.headers, fingerprint, body };

    if response.status >= 400 {
        let status = response.status;
        let parsed = response.json(1024 * 1024).ok();
        let error = parsed.as_ref().and_then(|value| value.get("error"));
        let code = error
            .and_then(|e| e.get("code"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("http_{status}"));
        let message = error
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("HTTP {status}"));
        let details = error.and_then(|e| e.get("details")).cloned();
        return Err(Failure::Final(PeerError { status, code, message, details }));
    }
    Ok(response)
}

/// Perform one request.
pub fn request(target: &Target, options: Options<'_>) -> Result<Response, PeerError> {
    if options.cancelled.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
        return Err(PeerError::new("ABORT_ERR", "Request aborted."));
    }
    if let Some(pool) = options.pool {
        if let Some(connection) = pool.take() {
            match send(target, &options, connection) {
                Ok(response) => return Ok(response),
                Err(Failure::Final(error)) => return Err(error),
                // A pooled connection the server had closed: once more, fresh.
                Err(Failure::BeforeResponse(_)) => {}
            }
        }
    }
    let connection =
        connect(target, options.timeout_ms).map_err(|error| transport_error(target, &error, options.timeout_ms))?;
    match send(target, &options, connection) {
        Ok(response) => Ok(response),
        Err(Failure::Final(error)) => Err(error),
        Err(Failure::BeforeResponse(error)) => Err(transport_error(target, &error, options.timeout_ms)),
    }
}

/// A request whose answer is JSON.
pub fn request_json(target: &Target, options: Options<'_>, limit: usize) -> Result<(Value, Option<String>), PeerError> {
    let response = request(target, options)?;
    let fingerprint = response.fingerprint.clone();
    Ok((response.json(limit)?, fingerprint))
}
