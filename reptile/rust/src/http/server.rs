//! The HTTP/1.1 server: one thread per connection, keep-alive, optional TLS.
//!
//! Two details matter for talking to Node.js peers:
//!  - Keep-alive responses carry `Keep-Alive: timeout=5`, like Node's own
//!    server. Node's HTTP agent reads that hint and retires idle sockets a
//!    second early; without it, it would reuse a socket this server just
//!    closed and fail the request.
//!  - `Expect: 100-continue` is answered lazily: the `100 Continue` goes out
//!    when the handler starts reading the body. A route that refuses an
//!    upload from its headers alone answers without ever asking for the body,
//!    and the connection is then closed (the client never sent it).

use crate::domain::errors::{AppError, AppResult};
use crate::http::conn::Stream;
use crate::http::message::{framing, read_request_head, reason, BodyState, ChunkedWriter, Headers};
use crate::util::logger::Logger;
use crate::util::net::display_ip;
use crate::util::threads::Locked;
use crate::util::url::query_param;
use rustls::{ServerConfig, ServerConnection, StreamOwned};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// Headers applied to every response.
pub const SECURITY_HEADERS: &[(&str, &str)] =
    &[("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"), ("X-Frame-Options", "DENY")];

const MAX_HEAD: usize = 64 * 1024;
const MAX_CONNECTIONS: usize = 1024;
const KEEP_ALIVE_MS: u64 = 5000;
const REQUEST_TIMEOUT_MS: u64 = 60_000;

/// An incoming request; its body is read through `Read`.
pub struct Request<'a> {
    pub method: String,
    /// The path, without the query string, as sent.
    pub path: String,
    pub query: String,
    pub headers: Headers,
    /// The client's address, IPv4-mapped addresses unwrapped.
    pub remote: String,
    pub expect_continue: bool,
    reader: &'a mut BufReader<Stream>,
    body: BodyState,
    continue_pending: bool,
}

impl Request<'_> {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name)
    }

    pub fn query_param(&self, name: &str) -> Option<String> {
        query_param(&self.query, name)
    }

    /// Read a whole body with a hard size limit.
    pub fn read_body(&mut self, limit: usize) -> AppResult<Vec<u8>> {
        let mut out = Vec::new();
        let mut buffer = [0u8; 16 * 1024];
        loop {
            let read = self
                .read(&mut buffer)
                .map_err(|_| AppError::bad_request("The request body could not be read.", "bad_request"))?;
            if read == 0 {
                return Ok(out);
            }
            if out.len() + read > limit {
                return Err(AppError::payload_too_large("Request body is too large."));
            }
            out.extend_from_slice(&buffer[..read]);
        }
    }

    /// Read and parse a JSON object body; an empty body yields `{}`.
    ///
    /// Requiring `application/json` is also the CSRF defence of the interface
    /// routes: a cross-origin page cannot send that content type without a
    /// CORS preflight, and this server never answers preflights.
    pub fn read_json(&mut self, limit: usize) -> AppResult<Value> {
        let content_type =
            self.header("content-type").unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        let raw = self.read_body(limit)?;
        if raw.is_empty() {
            return Ok(Value::Object(Default::default()));
        }
        if content_type != "application/json" {
            return Err(AppError::unsupported_media("Expected an application/json body."));
        }
        let parsed: Value =
            serde_json::from_slice(&raw).map_err(|_| AppError::bad_request("Malformed JSON body.", "bad_request"))?;
        if !parsed.is_object() {
            return Err(AppError::bad_request("The JSON body must be an object.", "bad_request"));
        }
        Ok(parsed)
    }
}

impl Read for Request<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.body.done {
            return Ok(0);
        }
        if self.continue_pending {
            self.continue_pending = false;
            let stream = self.reader.get_mut();
            stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
            stream.flush()?;
        }
        self.body.read(self.reader, buffer)
    }
}

pub type StreamFn = Box<dyn FnOnce(&mut ChunkedWriter<'_>) -> io::Result<()> + Send>;

pub enum ReplyBody {
    Empty,
    Bytes(Vec<u8>),
    /// Exactly `length` bytes of the file (a file growing meanwhile must not
    /// overflow Content-Length; one shrinking ends the connection early).
    File {
        file: File,
        length: u64,
    },
    /// A chunked stream that lasts as long as the function writes.
    Stream(StreamFn),
}

pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: ReplyBody,
    /// Runs once the whole body was written.
    pub on_complete: Option<Box<dyn FnOnce() + Send>>,
    /// Close the connection after this response.
    pub close: bool,
}

impl Reply {
    pub fn new(status: u16, headers: Vec<(String, String)>, body: ReplyBody) -> Reply {
        Reply { status, headers, body, on_complete: None, close: false }
    }

    /// A JSON answer. API answers are never cacheable.
    pub fn json(status: u16, value: &Value) -> Reply {
        Reply::new(
            status,
            vec![
                ("Content-Type".into(), "application/json; charset=utf-8".into()),
                ("Cache-Control".into(), "no-store".into()),
            ],
            ReplyBody::Bytes(value.to_string().into_bytes()),
        )
    }

    /// `{ error: { code, message } }`.
    pub fn error(error: &AppError) -> Reply {
        Reply::json(error.status, &serde_json::json!({ "error": error.to_json() }))
    }

    pub fn html(status: u16, text: &str) -> Reply {
        Reply::new(
            status,
            vec![
                ("Content-Type".into(), "text/html; charset=utf-8".into()),
                ("Cache-Control".into(), "no-store".into()),
            ],
            ReplyBody::Bytes(text.as_bytes().to_vec()),
        )
    }

    pub fn header(mut self, name: &str, value: &str) -> Reply {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    pub fn closing(mut self) -> Reply {
        self.close = true;
        self
    }
}

pub type Handler = Arc<dyn Fn(&mut Request<'_>) -> Reply + Send + Sync>;

pub struct Server {
    listener: TcpListener,
    address: SocketAddr,
    tls: Option<Arc<ServerConfig>>,
    handler: Handler,
    connections: Mutex<HashMap<u64, TcpStream>>,
    next_id: AtomicU64,
    active: AtomicUsize,
    closed: AtomicBool,
    logger: Logger,
}

impl Server {
    pub fn new(
        listener: TcpListener,
        tls: Option<Arc<ServerConfig>>,
        handler: Handler,
        logger: Logger,
    ) -> io::Result<Arc<Server>> {
        let address = listener.local_addr()?;
        Ok(Arc::new(Server {
            listener,
            address,
            tls,
            handler,
            connections: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            active: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
            logger,
        }))
    }

    pub fn port(&self) -> u16 {
        self.address.port()
    }

    /// Accept connections on a background thread until `close`.
    pub fn serve(self: &Arc<Self>) {
        let server = self.clone();
        std::thread::Builder::new()
            .name("http-accept".into())
            .spawn(move || {
                for incoming in server.listener.incoming() {
                    if server.closed.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(socket) = incoming else { continue };
                    if server.active.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                        continue; // dropped: too many at once
                    }
                    server.active.fetch_add(1, Ordering::SeqCst);
                    let worker = server.clone();
                    let spawned =
                        std::thread::Builder::new().name("http-conn".into()).stack_size(1024 * 1024).spawn(move || {
                            let id = worker.next_id.fetch_add(1, Ordering::SeqCst);
                            if let Ok(closer) = socket.try_clone() {
                                worker.connections.locked().insert(id, closer);
                            }
                            let _ =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| worker.connection(socket)));
                            if let Some(socket) = worker.connections.locked().remove(&id) {
                                let _ = socket.shutdown(std::net::Shutdown::Both);
                            }
                            worker.active.fetch_sub(1, Ordering::SeqCst);
                        });
                    if spawned.is_err() {
                        server.active.fetch_sub(1, Ordering::SeqCst);
                    }
                }
            })
            .expect("spawn the accept thread");
    }

    /// Stop accepting and close every open connection (event streams never
    /// end by themselves).
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        // Wake the blocking accept.
        let wake = if self.address.ip().is_unspecified() {
            SocketAddr::new(
                if self.address.is_ipv4() { [127, 0, 0, 1].into() } else { std::net::Ipv6Addr::LOCALHOST.into() },
                self.address.port(),
            )
        } else {
            self.address
        };
        let _ = TcpStream::connect_timeout(&wake, std::time::Duration::from_millis(500));
        for (_, socket) in self.connections.locked().drain() {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
    }

    /// Drop every open connection but keep listening (a network blip).
    pub fn drop_connections(&self) {
        for (_, socket) in self.connections.locked().drain() {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
    }

    fn connection(&self, socket: TcpStream) {
        let _ = socket.set_nodelay(true);
        let remote = socket.peer_addr().map(|a| display_ip(a.ip())).unwrap_or_default();
        let stream = match &self.tls {
            None => Stream::Plain(socket),
            Some(config) => {
                let Ok(connection) = ServerConnection::new(config.clone()) else { return };
                let mut tls = StreamOwned::new(connection, socket);
                let _ = tls.sock.set_read_timeout(Some(std::time::Duration::from_secs(10)));
                let _ = tls.sock.set_write_timeout(Some(std::time::Duration::from_secs(10)));
                while tls.conn.is_handshaking() {
                    if let Err(error) = tls.conn.complete_io(&mut tls.sock) {
                        // Plain-HTTP probes against an HTTPS port fail here: expected.
                        self.logger.debug(format_args!("TLS client error: {error}"));
                        return;
                    }
                }
                Stream::TlsServer(Box::new(tls))
            }
        };
        let mut reader = BufReader::with_capacity(16 * 1024, stream);
        let mut first = true;
        loop {
            if self.closed.load(Ordering::SeqCst) {
                return;
            }
            reader.get_ref().set_timeout(if first { REQUEST_TIMEOUT_MS } else { KEEP_ALIVE_MS });
            match reader.fill_buf() {
                Ok([]) | Err(_) => return,
                Ok(_) => {}
            }
            reader.get_ref().set_timeout(REQUEST_TIMEOUT_MS);
            let head = match read_request_head(&mut reader, MAX_HEAD) {
                Ok(Some(head)) => head,
                Ok(None) => return,
                Err(error) => {
                    self.logger.debug(format_args!("client error: {error}"));
                    let _ = reader.get_mut().write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
                    return;
                }
            };
            let Ok(body_framing) = framing(&head.headers, true) else {
                let _ = reader.get_mut().write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
                return;
            };
            let expect_continue =
                head.headers.get("expect").map(|v| v.eq_ignore_ascii_case("100-continue")).unwrap_or(false);
            let (path, query) = match head.target.split_once('?') {
                Some((path, query)) => (path.to_string(), query.to_string()),
                None => (head.target.clone(), String::new()),
            };
            let head_only = head.method == "HEAD";
            let wants_close = !head.http11 || head.headers.has_token("connection", "close");
            let mut request = Request {
                method: head.method,
                path,
                query,
                headers: head.headers,
                remote: remote.clone(),
                expect_continue,
                body: BodyState::new(body_framing),
                continue_pending: expect_continue,
                reader: &mut reader,
            };
            let reply = (self.handler)(&mut request);
            let mut keep_alive = !wants_close && !reply.close && !matches!(reply.body, ReplyBody::Stream(_));
            let unread = !request.body.done;
            let never_sent = request.continue_pending;
            let mut body =
                std::mem::replace(&mut request.body, BodyState::new(crate::http::message::Framing::Length(0)));
            drop(request);
            if unread && never_sent {
                // The client waits for 100 Continue and will not send the body.
                keep_alive = false;
            }
            if self.write_reply(&mut reader, reply, head_only, keep_alive).is_err() {
                return;
            }
            if !keep_alive {
                return;
            }
            // Keep the connection usable: drain what the client still sends.
            if unread && !body.drain(&mut reader, 1024 * 1024) {
                return;
            }
            first = false;
        }
    }

    fn write_reply(
        &self,
        reader: &mut BufReader<Stream>,
        reply: Reply,
        head_only: bool,
        keep_alive: bool,
    ) -> io::Result<()> {
        let Reply { status, headers, body, on_complete, .. } = reply;
        let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
        for (name, value) in SECURITY_HEADERS {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        for (name, value) in &headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        match &body {
            ReplyBody::Empty => head.push_str("Content-Length: 0\r\n"),
            ReplyBody::Bytes(bytes) => head.push_str(&format!("Content-Length: {}\r\n", bytes.len())),
            ReplyBody::File { length, .. } => head.push_str(&format!("Content-Length: {length}\r\n")),
            ReplyBody::Stream(_) => head.push_str("Transfer-Encoding: chunked\r\n"),
        }
        if matches!(body, ReplyBody::Stream(_)) {
            head.push_str("Connection: keep-alive\r\n");
        } else if keep_alive {
            head.push_str(&format!("Connection: keep-alive\r\nKeep-Alive: timeout={}\r\n", KEEP_ALIVE_MS / 1000));
        } else {
            head.push_str("Connection: close\r\n");
        }
        head.push_str("\r\n");
        let stream = reader.get_mut();
        let mut written_whole = true;
        match body {
            ReplyBody::Bytes(bytes) if !head_only => {
                let mut message = head.into_bytes();
                message.extend_from_slice(&bytes);
                stream.write_all(&message)?;
            }
            ReplyBody::File { mut file, length } if !head_only => {
                stream.write_all(head.as_bytes())?;
                let mut left = length;
                let mut buffer = vec![0u8; 256 * 1024];
                while left > 0 {
                    let wanted = (buffer.len() as u64).min(left) as usize;
                    let read = file.read(&mut buffer[..wanted])?;
                    if read == 0 {
                        // The file shrank: end the connection, the peer's size
                        // check rejects the short body.
                        written_whole = false;
                        break;
                    }
                    stream.write_all(&buffer[..read])?;
                    left -= read as u64;
                }
            }
            ReplyBody::Stream(run) if !head_only => {
                stream.write_all(head.as_bytes())?;
                stream.flush()?;
                // A stream may live for hours; its own writes detect a gone client.
                stream.set_timeout(30_000);
                let mut writer = ChunkedWriter { inner: stream };
                let _ = run(&mut writer);
                let _ = writer.finish();
                return Err(io::Error::other("stream ended"));
            }
            _ => stream.write_all(head.as_bytes())?,
        }
        stream.flush()?;
        if !written_whole {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "file shrank"));
        }
        if let Some(done) = on_complete {
            done();
        }
        Ok(())
    }
}
