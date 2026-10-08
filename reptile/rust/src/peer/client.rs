//! The syncing side's client for the host's peer API.
//!
//! One client per target (address, port, protocol). It keeps a pool of
//! keep-alive connections for the many small requests of a synchronisation,
//! a separate connection for the long-lived event stream, the bearer token of
//! the current session, and the certificate fingerprint pinned when that
//! session was opened. It talks to Rust and Node.js hosts alike.

use crate::domain::identity::Identity;
use crate::domain::protocol::{headers, paths, Timing};
use crate::domain::transport::{Download, OnClose, OnMessage, PeerApi, PeerError, PeerResult, StreamHandle};
use crate::fs::entry::{Kind, State};
use crate::http::client::{io_code, request, request_json, Body, Options, Pool, Target};
use crate::util::threads::spawn;
use crate::util::threads::Locked;
use crate::util::url::encode_component;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::{Shutdown, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub struct PeerClient {
    target: Target,
    protocol: &'static str,
    identity: Arc<Identity>,
    timing: Timing,
    pool: Arc<Pool>,
    token: Mutex<Option<String>>,
    fingerprint: Mutex<Option<String>>,
}

struct Stream {
    closer: Option<TcpStream>,
    closed: Arc<AtomicBool>,
}

impl StreamHandle for Stream {
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Some(socket) = &self.closer {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}

impl PeerClient {
    pub fn new(
        address: &str,
        port: u16,
        protocol: &'static str,
        identity: Arc<Identity>,
        timing: Timing,
    ) -> PeerClient {
        PeerClient {
            target: Target::new(protocol, address, port),
            protocol,
            identity,
            timing,
            pool: Pool::new(),
            token: Mutex::new(None),
            fingerprint: Mutex::new(None),
        }
    }

    /// The certificate fingerprint pinned when the session was opened.
    pub fn fingerprint(&self) -> Option<String> {
        self.fingerprint.locked().clone()
    }

    fn auth(&self, options: &mut Options<'_>) {
        if let Some(token) = self.token.locked().as_ref() {
            options.headers.push(("Authorization".into(), format!("Bearer {token}")));
        }
        options.fingerprint = self.fingerprint.locked().clone();
    }

    fn call<'a>(&'a self, mut options: Options<'a>, limit: usize) -> PeerResult<Value> {
        self.auth(&mut options);
        options.pool = Some(&self.pool);
        request_json(&self.target, options, limit).map(|(value, _)| value)
    }
}

impl PeerApi for PeerClient {
    fn address(&self) -> &str {
        &self.target.host
    }

    fn port(&self) -> u16 {
        self.target.port
    }

    fn protocol(&self) -> &str {
        self.protocol
    }

    fn token(&self) -> Option<String> {
        self.token.locked().clone()
    }

    fn set_token(&self, token: Option<String>) {
        *self.token.locked() = token;
    }

    fn ping(&self) -> PeerResult<Value> {
        let (mut value, fingerprint) = request_json(&self.target, Options::get(paths::PING, 4000), 64 * 1024)?;
        if value.is_object() {
            value["fingerprint"] = json!(fingerprint);
        }
        Ok(value)
    }

    fn connect(&self, pin: &str, local_path: &str) -> PeerResult<Value> {
        let body = json!({
            "pin": pin,
            "protocol": self.identity.protocol,
            "peer": {
                "uuid": self.identity.uuid,
                "hostname": self.identity.hostname,
                "machine": self.identity.machine,
                "localPath": local_path,
            },
        });
        let mut options = Options::post_json(paths::CONNECT, &body, 8000);
        options.pool = Some(&self.pool);
        let (value, fingerprint) = request_json(&self.target, options, 1024 * 1024)?;
        *self.token.locked() = value.get("token").and_then(Value::as_str).map(str::to_string);
        *self.fingerprint.locked() = fingerprint;
        Ok(value)
    }

    /// The stream's inactivity timeout doubles as the liveness check: the host
    /// writes a heartbeat line every few seconds, so a stream silent for
    /// longer than `stream_silence_ms` is dead.
    fn open_stream(&self, mut on_message: OnMessage, on_close: OnClose) -> PeerResult<Arc<dyn StreamHandle>> {
        let mut options = Options::get(paths::STREAM, self.timing.stream_silence_ms);
        options.headers.push(("Accept".into(), "application/x-ndjson".into()));
        self.auth(&mut options);
        let response = request(&self.target, options)?;
        let body = response.into_body();
        let closed = Arc::new(AtomicBool::new(false));
        let handle = Arc::new(Stream { closer: body.closer(), closed: closed.clone() });
        spawn("peer-stream", move || {
            let mut reader = BufReader::with_capacity(64 * 1024, body);
            let mut line = Vec::new();
            let outcome = loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) => break None,
                    Ok(_) => {
                        if closed.load(Ordering::SeqCst) {
                            return;
                        }
                        let text = String::from_utf8_lossy(&line);
                        let text = text.trim();
                        if text.is_empty() {
                            continue;
                        }
                        if let Ok(message) = serde_json::from_str::<Value>(text) {
                            on_message(message);
                        }
                    }
                    Err(error) => break Some(PeerError::new(io_code(&error), error.to_string())),
                }
            };
            if !closed.load(Ordering::SeqCst) {
                on_close(outcome);
            }
        });
        Ok(handle)
    }

    fn manifest(&self) -> PeerResult<Value> {
        self.call(Options::get(paths::MANIFEST, 60_000), 512 * 1024 * 1024)
    }

    fn hashes(&self, paths_list: &[String]) -> PeerResult<HashMap<String, String>> {
        let value =
            self.call(Options::post_json(paths::HASHES, &json!({ "paths": paths_list }), 120_000), 64 * 1024 * 1024)?;
        let mut out = HashMap::new();
        if let Some(map) = value.get("hashes").and_then(Value::as_object) {
            for (path, hash) in map {
                if let Some(hash) = hash.as_str() {
                    out.insert(path.clone(), hash.to_string());
                }
            }
        }
        Ok(out)
    }

    fn download(&self, path: &str) -> PeerResult<Download> {
        let location = format!("{}?path={}", paths::FILE, encode_component(path));
        let mut options = Options::get(&location, 30_000);
        options.headers.push(("Accept".into(), "application/octet-stream".into()));
        self.auth(&mut options);
        options.pool = Some(&self.pool);
        let response = request(&self.target, options)?;
        let header = |name: &str| response.headers.get(name).and_then(|v| v.trim().parse::<f64>().ok());
        let size = header(headers::SIZE).or_else(|| header("content-length"));
        let mtime = header(headers::MTIME);
        let (Some(size), Some(mtime)) = (size, mtime) else {
            return Err(PeerError::new("bad_response", "The host sent a file without its size or modification time."));
        };
        Ok(Download { body: Box::new(response.into_body()), size: size as u64, mtime_ms: mtime as i64 })
    }

    fn upload(&self, path: &str, absolute: &Path, size: u64, mtime_ms: i64, base: Option<&State>) -> PeerResult<Value> {
        let location = format!("{}?path={}", paths::FILE, encode_component(path));
        let mut options = Options::get(&location, 60_000);
        options.method = "PUT";
        options.headers.push(("Content-Type".into(), "application/octet-stream".into()));
        options.headers.push(("Content-Length".into(), size.to_string()));
        options.headers.push((headers::SIZE.into(), size.to_string()));
        options.headers.push((headers::MTIME.into(), mtime_ms.to_string()));
        if let Some(base) = base.filter(|b| b.kind != Kind::Dir) {
            options.headers.push((headers::BASE_SIZE.into(), base.size.to_string()));
            options.headers.push((headers::BASE_MTIME.into(), base.mtime_ms.to_string()));
        }
        if size == 0 {
            options.body = Body::Bytes(Vec::new());
        } else {
            options.body = Body::File { path: absolute, length: size };
            options.expect_continue = true;
        }
        self.call(options, 1024 * 1024)
    }

    fn ops(&self, list: &[Value]) -> PeerResult<Vec<Value>> {
        let value = self.call(Options::post_json(paths::OPS, &json!({ "ops": list }), 60_000), 64 * 1024 * 1024)?;
        Ok(value.get("results").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    fn heartbeat(&self, report: &Value) -> PeerResult<()> {
        self.call(Options::post_json(paths::HEARTBEAT, report, 5000), 64 * 1024).map(|_| ())
    }

    fn disconnect(&self) -> PeerResult<()> {
        if self.token.locked().is_none() {
            return Ok(());
        }
        let result = self.call(Options::post_json(paths::DISCONNECT, &json!({}), 2000), 64 * 1024);
        *self.token.locked() = None;
        result.map(|_| ())
    }

    fn close(&self) {
        self.pool.clear();
    }
}
