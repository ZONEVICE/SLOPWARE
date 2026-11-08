//! Shared harness for the integration tests: a real Tendril instance started
//! in process on an ephemeral port with its own temporary data directory,
//! plus a tiny blocking HTTP/1.1 client (plain or TLS) that keeps the
//! session cookie and sends a same-origin `Origin` header like a browser.

#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tendril::app::{self, Options};
use tendril::config::cli::Scheme;
use tendril::config::paths::DataDir;
use tendril::http::state::AppState;

pub const PASSWORD: &str = "correct horse";

/// A unique temporary directory, removed on drop.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> TempDir {
        let mut bytes = [0u8; 6];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).unwrap();
        let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let path = std::env::temp_dir().join(format!("tendril-it-{tag}-{name}"));
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A running server.
pub struct Server {
    pub addr: SocketAddr,
    pub state: AppState,
    pub scheme: Scheme,
    pub data: TempDir,
    pub workspace: TempDir,
    thread: Option<JoinHandle<String>>,
}

impl Server {
    pub fn start(scheme: Scheme) -> Server {
        Server::start_with(scheme, |_| {})
    }

    /// Starts a server; `tweak` may adjust the options first.
    pub fn start_with(scheme: Scheme, tweak: impl FnOnce(&mut Options)) -> Server {
        let data = TempDir::new("data");
        let workspace = TempDir::new("ws");
        let mut options = Options {
            scheme,
            password: Some(PASSWORD.into()),
            port: Some(0),
            bind: Some("127.0.0.1".parse().unwrap()),
            data_dir: DataDir::at(data.path().join(".tendril")),
            console: false,
            watchdog_every: Duration::from_millis(50),
        };
        tweak(&mut options);
        let (tx, rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            runtime.block_on(async move {
                let started = match app::start(options).await {
                    Ok(started) => started,
                    Err(err) => {
                        let _ = tx.send(Err(err.clone()));
                        return err;
                    }
                };
                let _ = tx.send(Ok((started.addr, started.state.clone())));
                app::run_until_stopped(started).await
            })
        });
        let (addr, state) =
            rx.recv_timeout(Duration::from_secs(20)).expect("server start timed out").expect("server failed");
        Server { addr, state, scheme, data, workspace, thread: Some(thread) }
    }

    /// A new client with no session.
    pub fn client(&self) -> Client {
        Client::new(self.addr, self.scheme)
    }

    /// A client that is logged in and has opened the workspace.
    pub fn session(&self) -> Client {
        let mut client = self.client();
        assert_eq!(client.login(PASSWORD).status, 200);
        let path = self.workspace.path().to_string_lossy().into_owned();
        let response = client.post_json("/api/workspace/open", &serde_json::json!({ "path": path }));
        assert_eq!(response.status, 200, "{}", response.text());
        client.workspace = Some(response.json()["id"].as_str().unwrap().to_string());
        client
    }

    /// Writes a file inside the workspace.
    pub fn write(&self, rel: &str, content: impl AsRef<[u8]>) {
        let path = self.workspace.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    /// Reads a file inside the workspace.
    pub fn read(&self, rel: &str) -> Vec<u8> {
        std::fs::read(self.workspace.path().join(rel)).unwrap()
    }

    /// Waits for the server to stop on its own and returns the reason.
    pub fn wait_stopped(&mut self, timeout: Duration) -> String {
        let thread = self.thread.take().unwrap();
        let deadline = std::time::Instant::now() + timeout;
        while !thread.is_finished() {
            assert!(std::time::Instant::now() < deadline, "server did not stop in time");
            std::thread::sleep(Duration::from_millis(20));
        }
        thread.join().unwrap()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(thread) = self.thread.take() {
            self.state.shutdown.trigger("test finished");
            let _ = thread.join();
        }
    }
}

/// An HTTP response.
#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.text()))
    }
}

/// Accepts any certificate (Tendril's is self-signed) but still checks the
/// handshake signatures with ring.
#[derive(Debug)]
struct AcceptAny(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for AcceptAny {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// TLS client configuration that trusts any server certificate.
pub fn insecure_tls() -> Arc<rustls::ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAny(provider)))
        .with_no_client_auth();
    Arc::new(config)
}

/// A blocking HTTP/1.1 client, one connection per request.
pub struct Client {
    pub addr: SocketAddr,
    pub scheme: Scheme,
    pub cookie: Option<String>,
    pub workspace: Option<String>,
    /// `Some(origin)` is sent as `Origin`; `None` sends no Origin header.
    pub origin: Option<String>,
    pub host: String,
}

impl Client {
    pub fn new(addr: SocketAddr, scheme: Scheme) -> Client {
        let host = format!("127.0.0.1:{}", addr.port());
        Client {
            addr,
            scheme,
            cookie: None,
            workspace: None,
            origin: Some(format!("{}://{host}", scheme.as_str())),
            host,
        }
    }

    /// Sends a request and reads the whole response.
    pub fn request(&self, method: &str, path: &str, extra: &[(&str, &str)], body: &[u8]) -> Response {
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n", self.host);
        if let Some(origin) = &self.origin {
            head.push_str(&format!("Origin: {origin}\r\n"));
        }
        if let Some(cookie) = &self.cookie {
            head.push_str(&format!("Cookie: {cookie}\r\n"));
        }
        if let Some(ws) = &self.workspace {
            head.push_str(&format!("X-Tendril-Workspace: {ws}\r\n"));
        }
        for (k, v) in extra {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        if !body.is_empty() || matches!(method, "POST" | "PUT" | "PATCH") {
            head.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        head.push_str("\r\n");
        let mut raw = Vec::new();
        let tcp = TcpStream::connect(self.addr).unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        match self.scheme {
            Scheme::Http => {
                let mut tcp = tcp;
                tcp.write_all(head.as_bytes()).unwrap();
                tcp.write_all(body).unwrap();
                let _ = tcp.read_to_end(&mut raw);
            }
            Scheme::Https => {
                let name = ServerName::try_from("localhost").unwrap();
                let conn = rustls::ClientConnection::new(insecure_tls(), name).unwrap();
                let mut tls = rustls::StreamOwned::new(conn, tcp);
                tls.write_all(head.as_bytes()).unwrap();
                tls.write_all(body).unwrap();
                tls.flush().unwrap();
                let _ = tls.read_to_end(&mut raw);
            }
        }
        parse_response(&raw)
    }

    pub fn get(&self, path: &str) -> Response {
        self.request("GET", path, &[], b"")
    }

    pub fn post_json(&self, path: &str, json: &serde_json::Value) -> Response {
        self.request("POST", path, &[("Content-Type", "application/json")], json.to_string().as_bytes())
    }

    pub fn patch_json(&self, path: &str, json: &serde_json::Value) -> Response {
        self.request("PATCH", path, &[("Content-Type", "application/json")], json.to_string().as_bytes())
    }

    /// Logs in; keeps the session cookie on success.
    pub fn login(&mut self, password: &str) -> Response {
        let response = self.post_json("/api/auth/login", &serde_json::json!({ "password": password }));
        if let Some(set) = response.header("set-cookie") {
            self.cookie = Some(set.split(';').next().unwrap().to_string());
        }
        response
    }
}

/// Parses a raw HTTP/1.1 response (Content-Length, chunked or until close).
pub fn parse_response(raw: &[u8]) -> Response {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("no header terminator in response");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
    let headers: Vec<(String, String)> =
        lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect();
    let mut body = raw[split + 4..].to_vec();
    let chunked = headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.contains("chunked"));
    if chunked {
        let mut out = Vec::new();
        let mut rest = &body[..];
        loop {
            let line_end = rest.windows(2).position(|w| w == b"\r\n").unwrap();
            let size = usize::from_str_radix(std::str::from_utf8(&rest[..line_end]).unwrap().trim(), 16).unwrap();
            rest = &rest[line_end + 2..];
            if size == 0 {
                break;
            }
            out.extend_from_slice(&rest[..size]);
            rest = &rest[size + 2..];
        }
        body = out;
    }
    Response { status, headers, body }
}

/// Percent-encodes a query value.
pub fn enc(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
