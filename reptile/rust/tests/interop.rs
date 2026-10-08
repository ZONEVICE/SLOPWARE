//! Interoperability with the Node.js implementation in `../node`.
//!
//! Each test starts a real Node.js Reptile process next to an in-process Rust
//! instance and checks that they find, host and sync with each other over the
//! wire protocol both implement. Skipped (with a message) when `node` or the
//! Node.js sources are not available.

mod common;

use common::*;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

fn node_entry() -> Option<PathBuf> {
    let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("node").join("src").join("index.js");
    let node_works = Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if entry.is_file() && node_works {
        Some(entry)
    } else {
        eprintln!("skipped: node or ../node/src/index.js is not available");
        None
    }
}

struct NodeInstance {
    child: Child,
    port: u16,
    protocol: &'static str,
    _cert: TempDir,
}

impl Drop for NodeInstance {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl NodeInstance {
    fn api(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        api(self.protocol, self.port, method, path, body)
    }

    fn state(&self) -> Value {
        self.api("GET", "/api/state", None).1
    }

    fn sync_state(&self) -> String {
        self.state()["syncing"]["state"].as_str().unwrap_or("").to_string()
    }
}

/// Start a Node.js instance on a port it picks itself (port 0), read from its
/// startup banner: choosing a free port here and handing it over would race
/// with the Rust instances other tests start in parallel.
fn start_node(entry: &Path, protocol: &'static str, extra: &[&str]) -> NodeInstance {
    use std::io::{BufRead, BufReader};
    let cert = TempDir::new("reptile-node-cert-");
    let mut command = Command::new("node");
    command
        .arg(entry)
        .args(["--host", "127.0.0.1", "--port", "0", "--log-level", "info"])
        .args(extra)
        .env("REPTILE_CERT_DIR", cert.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if protocol == "https" {
        command.arg("--https");
    }
    if !extra.iter().any(|a| a.starts_with("--scan")) {
        command.arg("--no-scan");
    }
    let mut child = command.spawn().expect("start node");
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !sent {
                if let Some(url) = line.split("control panel").nth(1) {
                    let port = url
                        .split_whitespace()
                        .next()
                        .unwrap_or("")
                        .rsplit(':')
                        .next()
                        .and_then(|p| p.parse::<u16>().ok());
                    if let Some(port) = port {
                        let _ = sender.send(port);
                        sent = true;
                    }
                }
            }
            // Keep draining so the process never blocks on a full pipe.
        }
    });
    let port = receiver.recv_timeout(Duration::from_secs(15)).expect("the Node.js instance did not report its port");
    let instance = NodeInstance { child, port, protocol, _cert: cert };
    let started = Instant::now();
    loop {
        let target = reptile::http::client::Target::new(protocol, "127.0.0.1", port);
        if let Ok(response) =
            reptile::http::client::request(&target, reptile::http::client::Options::get("/api/ping", 1000))
        {
            let ping = response.json(64 * 1024).unwrap_or(Value::Null);
            assert_eq!(ping["app"], "reptile");
            return instance;
        }
        assert!(started.elapsed() < Duration::from_secs(15), "the Node.js instance did not start");
        sleep(Duration::from_millis(100));
    }
}

#[cfg(unix)]
fn inode(path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).unwrap().ino()
}

/// The live scenarios every pairing must pass: `from` is where the user
/// works, `to` where the change must appear.
fn live_round(from: &Path, to: &Path) {
    fs::write(from.join("created.txt"), "fresh").unwrap();
    fs::create_dir_all(from.join("nested/deeper")).unwrap();
    fs::write(from.join("nested/deeper/leaf.bin"), vec![42u8; 300_000]).unwrap();
    wait_same_trees(from, to, 20_000);
    fs::write(from.join("created.txt"), "fresh, then edited").unwrap();
    wait_for("the edit", 15_000, || {
        fs::read_to_string(to.join("created.txt")).unwrap_or_default() == "fresh, then edited"
    });
    #[cfg(unix)]
    let before = inode(&to.join("nested/deeper/leaf.bin"));
    fs::rename(from.join("nested"), from.join("moved")).unwrap();
    wait_for("the rename", 15_000, || to.join("moved/deeper/leaf.bin").exists());
    wait_same_trees(from, to, 15_000);
    #[cfg(unix)]
    assert_eq!(inode(&to.join("moved/deeper/leaf.bin")), before, "renamed in place, not transferred again");
    fs::remove_dir_all(from.join("moved")).unwrap();
    fs::remove_file(from.join("created.txt")).unwrap();
    wait_same_trees(from, to, 15_000);
}

fn node_hosts_rust_syncs(protocol: &'static str) {
    let Some(entry) = node_entry() else { return };
    let node = start_node(&entry, protocol, &[]);
    let host_dir = TempDir::new("reptile-nodehost-");
    write_tree(
        host_dir.path(),
        &[("from-node.txt", Some("node")), ("docs/readme.md", Some("hello")), ("empty/", None)],
    );
    let (status, _) =
        node.api("POST", "/api/host", Some(json!({ "path": host_dir.text(), "name": "Node share", "pin": "2468" })));
    assert_eq!(status, 201);

    let rust = start(protocol);
    let sync_parent = TempDir::new("reptile-rustpeer-");
    let sync_dir = sync_parent.path().join("copy");
    fs::create_dir_all(&sync_dir).unwrap();
    fs::write(sync_dir.join("from-rust.txt"), "rust").unwrap();
    rust.app
        .modes
        .start_syncing(&json!({ "address": "127.0.0.1", "port": node.port, "localPath": sync_dir.to_string_lossy(), "pin": "2468" }))
        .expect("a Rust peer syncs from a Node.js host");
    wait_for("live", 20_000, || rust.sync_state() == Some("live"));
    wait_same_trees(host_dir.path(), &sync_dir, 20_000);
    assert_eq!(node.state()["hosting"]["session"]["peer"]["uuid"], rust.app.identity.uuid.as_str());

    live_round(host_dir.path(), &sync_dir);
    live_round(&sync_dir, host_dir.path());
}

fn rust_hosts_node_syncs(protocol: &'static str) {
    let Some(entry) = node_entry() else { return };
    let rust = start(protocol);
    let host_dir = TempDir::new("reptile-rusthost-");
    write_tree(
        host_dir.path(),
        &[("from-rust.txt", Some("rust")), ("docs/readme.md", Some("hello")), ("empty/", None)],
    );
    rust.app.modes.start_hosting(&json!({ "path": host_dir.text(), "name": "Rust share", "pin": "1357" })).unwrap();

    let node = start_node(&entry, protocol, &[]);
    let sync_parent = TempDir::new("reptile-nodepeer-");
    let sync_dir = sync_parent.path().join("copy");
    fs::create_dir_all(&sync_dir).unwrap();
    fs::write(sync_dir.join("from-node.txt"), "node").unwrap();
    let (status, body) = node.api(
        "POST",
        "/api/sync",
        Some(json!({ "address": "127.0.0.1", "port": rust.port, "localPath": sync_dir.to_string_lossy(), "pin": "1357" })),
    );
    assert_eq!(status, 201, "{body}");
    wait_for("live", 20_000, || node.sync_state() == "live");
    wait_same_trees(host_dir.path(), &sync_dir, 20_000);

    live_round(host_dir.path(), &sync_dir);
    live_round(&sync_dir, host_dir.path());
}

#[test]
fn a_rust_peer_syncs_from_a_node_host_over_http() {
    node_hosts_rust_syncs("http");
}

#[test]
fn a_node_peer_syncs_from_a_rust_host_over_http() {
    rust_hosts_node_syncs("http");
}

#[test]
fn a_rust_peer_syncs_from_a_node_host_over_https() {
    node_hosts_rust_syncs("https");
}

#[test]
fn a_node_peer_syncs_from_a_rust_host_over_https() {
    rust_hosts_node_syncs("https");
}

#[test]
fn a_pin_change_on_a_rust_host_pauses_a_node_peer_until_it_types_the_new_one() {
    let Some(entry) = node_entry() else { return };
    let rust = start("http");
    let host_dir = TempDir::new("reptile-rusthost-");
    write_tree(host_dir.path(), &[("a.txt", Some("a"))]);
    rust.app.modes.start_hosting(&json!({ "path": host_dir.text(), "pin": "1111" })).unwrap();
    let node = start_node(&entry, "http", &[]);
    let sync_parent = TempDir::new("reptile-nodepeer-");
    let sync_dir = sync_parent.path().join("copy");
    node.api("POST", "/api/sync", Some(json!({ "address": "127.0.0.1", "port": rust.port, "localPath": sync_dir.to_string_lossy(), "pin": "1111" })));
    wait_for("live", 20_000, || node.sync_state() == "live");
    rust.api("POST", "/api/host/pin", Some(json!({ "pin": "2222" })));
    wait_for("pin_required", 10_000, || node.sync_state() == "pin_required");
    fs::write(host_dir.path().join("during.txt"), "d").unwrap();
    let (status, _) = node.api("POST", "/api/sync/pin", Some(json!({ "pin": "2222" })));
    assert_eq!(status, 200);
    wait_for("live again", 20_000, || node.sync_state() == "live");
    wait_same_trees(host_dir.path(), &sync_dir, 20_000);
}

#[test]
fn a_directory_cannot_be_synced_into_itself_across_implementations() {
    let Some(entry) = node_entry() else { return };
    // Both implementations compute the same machine fingerprint, so each
    // recognises the other on this computer.
    let node = start_node(&entry, "http", &[]);
    let node_dir = TempDir::new("reptile-nodehost-");
    node.api("POST", "/api/host", Some(json!({ "path": node_dir.text(), "pin": "1234" })));
    let rust = start("http");
    let error = rust
        .app
        .modes
        .start_syncing(&json!({ "address": "127.0.0.1", "port": node.port, "localPath": node_dir.0.join("inside").to_string_lossy(), "pin": "1234" }))
        .unwrap_err();
    assert_eq!(error.code, "same_directory");

    let rust_dir = TempDir::new("reptile-rusthost-");
    let host = start("http");
    host.app.modes.start_hosting(&json!({ "path": rust_dir.text(), "pin": "1234" })).unwrap();
    let other = start_node(&entry, "http", &[]);
    let (status, body) = other.api(
        "POST",
        "/api/sync",
        Some(json!({ "address": "127.0.0.1", "port": host.port, "localPath": rust_dir.0.join("inside").to_string_lossy(), "pin": "1234" })),
    );
    assert_eq!((status, body["error"]["code"].as_str()), (400, Some("same_directory")));
}

#[test]
fn rust_and_node_instances_discover_each_other() {
    let Some(entry) = node_entry() else { return };
    // Ports are only known once each instance listens, so: a Rust instance to
    // be found, a Node.js instance scanning its port, then a Rust scanner
    // looking for the Node.js one.
    let target = start("http");
    let node = start_node(&entry, "http", &["--scan-hosts", "127.0.0.1", "--scan-ports", &target.port.to_string()]);
    let scanner = start_with("http", |config| {
        config.discovery.enabled = true;
        config.discovery.hosts = Some(vec!["127.0.0.1".into()]);
        config.discovery.ports = vec![node.port];
        config.discovery.sweep_interval_ms = 300;
        config.discovery.refresh_interval_ms = 300;
    });
    let dir = TempDir::new("reptile-disco-");
    node.api("POST", "/api/host", Some(json!({ "path": dir.text(), "name": "Seen by Rust", "pin": "1234" })));
    wait_for("Rust to list the Node.js instance", 15_000, || {
        scanner
            .app
            .discovery
            .list()
            .iter()
            .any(|i| i["port"] == node.port && i["hosting"]["name"] == "Seen by Rust" && i["compatible"] == true)
    });
    wait_for("Node.js to list the Rust instance", 30_000, || {
        node.state()["discovery"]["instances"]
            .as_array()
            .map(|list| list.iter().any(|i| i["uuid"] == target.app.identity.uuid.as_str()))
            .unwrap_or(false)
    });
}
