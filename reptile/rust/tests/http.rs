//! The HTTP surface: control panel files, the API, server-sent events, the
//! peer API's authentication, and the guard on a running server.

mod common;

use common::*;
use reptile::http::message::{read_response_head, BodyState, Framing};
use serde_json::{json, Value};
use std::io::{BufReader, Write};
use std::net::TcpStream;
use std::time::Duration;

/// A raw request; returns (status, lowercase headers, body).
fn raw(port: u16, request: &str) -> (u16, Vec<(String, String)>, String) {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
    socket.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    socket.write_all(request.as_bytes()).unwrap();
    let mut reader = BufReader::new(socket);
    let head = read_response_head(&mut reader, 64 * 1024).unwrap();
    let headers: Vec<(String, String)> = head.headers.iter().cloned().collect();
    let framing = reptile::http::message::framing(&head.headers, false).unwrap();
    let mut body = BodyState::new(framing);
    let mut out = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        match body.read(&mut reader, &mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => out.extend_from_slice(&buffer[..read]),
        }
    }
    (head.status, headers, String::from_utf8_lossy(&out).into_owned())
}

fn get(port: u16, path: &str) -> (u16, Vec<(String, String)>, String) {
    raw(port, &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"))
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> &'a str {
    headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str()).unwrap_or("")
}

#[test]
fn the_page_its_styles_and_its_scripts_are_served() {
    let instance = start("http");
    let (status, headers, body) = get(instance.port, "/");
    assert_eq!(status, 200);
    assert!(header(&headers, "content-type").contains("text/html"));
    assert!(body.contains("<title>Reptile</title>"));
    assert!(header(&headers, "content-security-policy").contains("default-src 'self'"));
    assert_eq!(header(&headers, "x-content-type-options"), "nosniff");
    for asset in ["/css/base.css", "/js/main.js", "/js/views/index.js", "/icons/favicon.svg"] {
        assert_eq!(get(instance.port, asset).0, 200, "{asset}");
    }
    assert!(header(&get(instance.port, "/js/main.js").1, "content-type").contains("javascript"));
}

#[test]
fn unknown_paths_are_404_api_ones_as_json_and_a_wrong_method_is_405() {
    let instance = start("http");
    assert_eq!(get(instance.port, "/nope.html").0, 404);
    let (status, _, body) = get(instance.port, "/api/nope");
    assert_eq!(status, 404);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["error"]["code"], "not_found");
    assert_eq!(get(instance.port, "/..%2f..%2fetc%2fpasswd").0, 404);
    let (status, _) = instance.api("PUT", "/api/state", Some(json!({})));
    assert_eq!(status, 405);
}

#[test]
fn the_state_snapshot_has_everything_the_status_bar_needs() {
    let instance = start("http");
    let (_, state) = instance.api("GET", "/api/state", None);
    assert_eq!(state["identity"]["uuid"], instance.app.identity.uuid.as_str());
    assert_eq!(state["identity"]["port"], instance.port);
    assert_eq!(state["identity"]["protocol"], "http");
    assert!(state["identity"]["hostname"].is_string());
    assert!(state["identity"]["address"].is_string());
    assert_eq!(state["mode"], "idle");
    assert!(state["discovery"]["enabled"].is_boolean());
}

#[test]
fn state_changes_are_pushed_over_server_sent_events() {
    let instance = start("http");
    let root = TempDir::new("reptile-sse-");
    let mut socket = TcpStream::connect(("127.0.0.1", instance.port)).unwrap();
    socket.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(socket, "GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n", instance.port).unwrap();
    let mut reader = BufReader::new(socket);
    let head = read_response_head(&mut reader, 64 * 1024).unwrap();
    assert!(head.headers.get("content-type").unwrap().contains("text/event-stream"));
    let mut body = BodyState::new(Framing::Chunked);
    let mut text = String::new();
    let mut buffer = [0u8; 65536];
    let mut states: Vec<Value> = Vec::new();
    let mut hosted = false;
    while states.last().map(|s| s["mode"] != "hosting").unwrap_or(true) {
        let read = body.read(&mut reader, &mut buffer).unwrap();
        text.push_str(&String::from_utf8_lossy(&buffer[..read]));
        while let Some(end) = text.find("\n\n") {
            let frame: String = text.drain(..end + 2).collect();
            if let Some(data) = frame.lines().find_map(|line| line.strip_prefix("data: ")) {
                states.push(serde_json::from_str(data).unwrap());
            }
        }
        if !states.is_empty() && !hosted {
            hosted = true;
            let (status, _) =
                instance.api("POST", "/api/host", Some(json!({ "path": root.text(), "name": "Live", "pin": "1234" })));
            assert_eq!(status, 201);
        }
    }
    assert_eq!(states[0]["mode"], "idle");
    assert_eq!(states.last().unwrap()["hosting"]["name"], "Live");
}

#[test]
fn bodies_must_be_json_objects() {
    let instance = start("http");
    let (status, _) = instance.api("POST", "/api/host", Some(json!("just a string")));
    assert_eq!(status, 400);
}

#[test]
fn everything_but_ping_and_connect_needs_a_session_token() {
    let instance = start("http");
    let root = TempDir::new("reptile-locked-");
    instance.app.modes.start_hosting(&json!({ "path": root.text(), "name": "Locked", "pin": "1234" })).unwrap();
    for (method, path, body) in [
        ("GET", "/api/peer/manifest", None),
        ("GET", "/api/peer/file?path=a", None),
        ("POST", "/api/peer/ops", Some(json!({ "ops": [] }))),
        ("POST", "/api/peer/hashes", Some(json!({ "paths": [] }))),
        ("POST", "/api/peer/heartbeat", Some(json!({}))),
    ] {
        let (status, _) =
            api_with("http", instance.port, method, path, body, &[("Authorization", "Bearer not-a-token")]);
        assert_eq!(status, 401, "{method} {path}");
    }
    assert_eq!(get(instance.port, "/api/peer/stream").0, 401);
    assert_eq!(instance.api("GET", "/api/ping", None).0, 200);
}

#[test]
fn connect_needs_the_pin_and_hands_out_a_token_that_works() {
    let instance = start("http");
    let root = TempDir::new("reptile-locked-");
    instance.app.modes.start_hosting(&json!({ "path": root.text(), "name": "Locked", "pin": "1234" })).unwrap();
    let peer = json!({ "uuid": "p", "hostname": "p" });
    let (status, _) =
        instance.api("POST", "/api/peer/connect", Some(json!({ "pin": "9999", "protocol": "http", "peer": peer })));
    assert_eq!(status, 403);
    let (status, right) =
        instance.api("POST", "/api/peer/connect", Some(json!({ "pin": "1234", "protocol": "http", "peer": peer })));
    assert_eq!(status, 200);
    let token = format!("Bearer {}", right["token"].as_str().unwrap());
    let (status, manifest) =
        api_with("http", instance.port, "GET", "/api/peer/manifest", None, &[("Authorization", &token)]);
    assert_eq!(status, 200);
    assert_eq!(manifest["entries"], json!([]));
}

#[test]
fn the_running_server_applies_the_guard_to_the_panel_but_not_to_peers() {
    let instance = start("http");
    let (status, _) = api_with(
        "http",
        instance.port,
        "POST",
        "/api/discovery",
        Some(json!({ "enabled": false })),
        &[("Origin", "http://evil.example")],
    );
    assert_eq!(status, 403);
    let ping = raw(instance.port, "GET /api/ping HTTP/1.1\r\nHost: anything.example\r\nConnection: close\r\n\r\n");
    assert_eq!(ping.0, 200, "peers may use any Host header");
    let state = raw(instance.port, "GET /api/state HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n");
    assert_eq!(state.0, 403);
}

#[test]
fn keep_alive_answers_carry_the_timeout_hint_node_agents_rely_on() {
    let instance = start("http");
    let (_, headers, _) =
        raw(instance.port, &format!("GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n", instance.port));
    assert_eq!(header(&headers, "connection"), "keep-alive");
    assert_eq!(header(&headers, "keep-alive"), "timeout=5");
}

#[test]
fn a_busy_port_is_not_an_error() {
    let busy = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = busy.local_addr().unwrap().port();
    let instance = start_with("http", |config| {
        config.port = port;
        config.port_attempts = 64;
    });
    assert!(instance.port > port);
    drop(busy);
}
