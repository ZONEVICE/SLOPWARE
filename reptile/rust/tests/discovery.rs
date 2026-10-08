//! The ping endpoint, the probe and the background discovery.

mod common;

use common::*;
use reptile::config::Config;
use reptile::domain::transport::{ProbeOptions, ProbeStatus};
use reptile::peer::probe::probe;
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

fn scan_only(config: &mut Config, ports: Vec<u16>) {
    config.discovery.enabled = true;
    config.discovery.hosts = Some(vec!["127.0.0.1".into()]);
    config.discovery.ports = ports;
    config.discovery.sweep_interval_ms = 250;
    config.discovery.refresh_interval_ms = 250;
    config.discovery.stale_ms = 1500;
    config.discovery.connect_timeout_ms = 300;
    config.discovery.request_timeout_ms = 1000;
}

fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
}

fn options(port: u16, prefer: &str) -> ProbeOptions {
    ProbeOptions {
        host: "127.0.0.1".into(),
        port,
        prefer_protocol: prefer.into(),
        connect_timeout_ms: 700,
        request_timeout_ms: 2000,
        skip_tcp_check: false,
        cancelled: None,
    }
}

#[test]
fn ping_identifies_the_instance_and_never_says_where_the_directory_is() {
    let instance = start("http");
    let (_, ping) = instance.api("GET", "/api/ping", None);
    assert_eq!(ping["app"], "reptile");
    assert_eq!(ping["protocol"], "http");
    assert_eq!(ping["protocolVersion"], 1);
    assert_eq!(ping["uuid"], instance.app.identity.uuid.as_str());
    assert_eq!(ping["version"], env!("CARGO_PKG_VERSION"));
    let root = TempDir::new("reptile-ping-");
    instance.app.modes.start_hosting(&json!({ "path": root.text(), "name": "Photos", "pin": "1234" })).unwrap();
    let (_, ping) = instance.api("GET", "/api/ping", None);
    assert_eq!(ping["hosting"]["name"], "Photos");
    let text = ping.to_string();
    assert!(!text.contains(&root.text()) && !text.contains("1234"), "{text}");
    assert_ne!(start("http").app.identity.uuid, instance.app.identity.uuid);
}

#[test]
fn the_probe_tells_closed_ports_strangers_and_instances_of_either_protocol() {
    let started = Instant::now();
    let closed = probe(&options(free_port(), "http"));
    assert_eq!(closed.status, ProbeStatus::Closed);
    assert!(started.elapsed() < Duration::from_secs(2));

    let stranger = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let stranger_port = stranger.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut socket in stranger.incoming().flatten().take(4) {
            let mut buffer = [0u8; 1024];
            let _ = socket.read(&mut buffer);
            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"hi\":true}");
        }
    });
    assert_eq!(probe(&options(stranger_port, "http")).status, ProbeStatus::NotReptile);

    let secure = start("https");
    let found = probe(&options(secure.port, "http"));
    assert_eq!(found.status, ProbeStatus::Found);
    assert_eq!(found.info.unwrap()["protocol"], "https");
    let plain = start("http");
    let found = probe(&options(plain.port, "https"));
    assert_eq!(found.info.unwrap()["protocol"], "http");
}

#[test]
fn discovery_finds_others_never_itself_and_follows_hosting() {
    let other = start("http");
    let own_port = free_port();
    let scanner = start_with("http", |config| {
        config.port = own_port;
        scan_only(config, vec![own_port, other.port]);
    });
    assert_eq!(scanner.port, own_port);
    wait_for("the other instance", 10_000, || scanner.app.discovery.list().len() == 1);
    wait_for("a second sweep", 10_000, || scanner.app.discovery.status()["sweeps"].as_u64().unwrap_or(0) > 1);
    let list = scanner.app.discovery.list();
    assert_eq!(list.len(), 1, "never lists itself");
    assert_eq!(list[0]["uuid"], other.app.identity.uuid.as_str());
    assert_eq!(list[0]["port"], other.port);
    assert_eq!(list[0]["compatible"], true);
    assert!(list[0]["hosting"].is_null());

    let root = TempDir::new("reptile-music-");
    other.app.modes.start_hosting(&json!({ "path": root.text(), "name": "Music", "pin": "1111" })).unwrap();
    wait_for("hosting to show up", 10_000, || {
        scanner.app.discovery.list().first().map(|i| i["hosting"]["name"] == "Music").unwrap_or(false)
    });
    other.app.modes.stop_hosting();
    wait_for("hosting to disappear", 10_000, || {
        scanner.app.discovery.list().first().map(|i| i["hosting"].is_null()).unwrap_or(false)
    });
    other.app.close();
    wait_for("the stopped instance to be forgotten", 10_000, || scanner.app.discovery.list().is_empty());
}

#[test]
fn instances_of_the_other_protocol_are_listed_as_incompatible() {
    let secure = start("https");
    let plain = start("http");
    let ports = vec![secure.port, plain.port];
    let http_scanner = start_with("http", |config| scan_only(config, ports.clone()));
    let https_scanner = start_with("https", |config| scan_only(config, ports.clone()));
    for (scanner, compatible) in [(&http_scanner, "http"), (&https_scanner, "https")] {
        wait_for("two instances", 10_000, || scanner.app.discovery.list().len() == 2);
        for instance in scanner.app.discovery.list() {
            assert_eq!(instance["compatible"] == true, instance["protocol"] == compatible, "{instance}");
        }
    }
}

#[test]
fn the_scan_can_be_switched_off_and_on_and_start_switched_off() {
    let other = start("http");
    let scanner = start_with("http", |config| scan_only(config, vec![other.port]));
    wait_for("a sweep", 10_000, || scanner.app.discovery.status()["sweeps"].as_u64().unwrap_or(0) > 0);
    let (status, off) = scanner.api("POST", "/api/discovery", Some(json!({ "enabled": false })));
    assert_eq!((status, off["enabled"].as_bool()), (200, Some(false)));
    std::thread::sleep(Duration::from_millis(300));
    let sweeps = scanner.app.discovery.status()["sweeps"].clone();
    std::thread::sleep(Duration::from_millis(900));
    assert_eq!(scanner.app.discovery.status()["sweeps"], sweeps, "no sweep while switched off");
    assert_eq!(scanner.app.discovery.status()["scanning"], false);
    let (_, on) = scanner.api("POST", "/api/discovery", Some(json!({ "enabled": true })));
    assert_eq!(on["enabled"], true);
    wait_for("scanning to resume", 10_000, || scanner.app.discovery.status()["sweeps"] != sweeps);
    let (status, _) = scanner.api("POST", "/api/discovery", Some(json!({ "enabled": "yes" })));
    assert_eq!(status, 400);

    let quiet = start_with("http", |config| {
        scan_only(config, vec![1]);
        config.discovery.enabled = false;
    });
    let (_, state) = quiet.api("GET", "/api/state", None);
    assert_eq!(state["discovery"]["enabled"], false);
}

#[test]
fn a_manual_address_is_verified_on_request() {
    let host = start("http");
    let root = TempDir::new("reptile-manual-");
    host.app.modes.start_hosting(&json!({ "path": root.text(), "name": "Manual", "pin": "1234" })).unwrap();
    let client = start("http");
    let (status, found) =
        client.api("POST", "/api/sync/inspect", Some(json!({ "address": "127.0.0.1", "port": host.port })));
    assert_eq!(status, 200);
    assert_eq!(found["compatible"], true);
    assert_eq!(found["info"]["hosting"]["name"], "Manual");
    let (status, nothing) =
        client.api("POST", "/api/sync/inspect", Some(json!({ "address": "127.0.0.1", "port": free_port() })));
    assert_eq!(status, 400);
    assert_eq!(nothing["error"]["code"], "unreachable");
    let (_, bad) = client.api("POST", "/api/sync/inspect", Some(json!({ "address": "127.0.0.1", "port": 70000 })));
    assert_eq!(bad["error"]["code"], "bad_port");
}
