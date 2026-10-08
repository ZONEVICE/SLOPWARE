//! Test helpers: isolated in-process instances, temporary directories,
//! polling, and tree snapshots for comparing both sides of a sync.
//!
//! Every instance listens on 127.0.0.1 with an ephemeral port, writes its
//! certificate to a temporary directory, has discovery switched off unless a
//! test turns it on, and uses fast watcher timings and heartbeats. Nothing
//! touches the real certificate directory or scans the real network.

#![allow(dead_code)]

use reptile::app::App;
use reptile::config::Config;
use reptile::domain::protocol::Timing;
use reptile::fs::entry::is_temp_name;
use reptile::fs::watcher::WatcherTiming;
use reptile::http::client::{request, Body, Options, Target};
use reptile::util::ids::{hex, random_hex};
use reptile::util::logger::{Level, Logger};
use ring::digest::{digest, SHA256};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::sleep;
use std::time::{Duration, Instant};

pub const FAST_WATCHER: WatcherTiming =
    WatcherTiming { quiet_ms: 40, max_wait_ms: 300, rename_window_ms: 350, stability_ms: 80, rescan_interval_ms: 0 };

pub const FAST_TIMING: Timing =
    Timing { stream_heartbeat_ms: 200, stream_silence_ms: 1500, peer_heartbeat_ms: 200, peer_silence_ms: 1500 };

/// A temporary directory removed on drop.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(prefix: &str) -> TempDir {
        let path = std::env::temp_dir().join(format!("{prefix}{}", random_hex(6)));
        fs::create_dir_all(&path).unwrap();
        // Canonical, so comparisons with what the instances report hold.
        TempDir(fs::canonicalize(&path).unwrap())
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn text(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub struct Instance {
    pub app: Arc<App>,
    pub port: u16,
    pub protocol: &'static str,
    _cert: TempDir,
}

impl Drop for Instance {
    fn drop(&mut self) {
        self.app.close();
    }
}

pub fn logger() -> Logger {
    let level = std::env::var("REPTILE_TEST_LOG").map(|l| Level::parse(&l)).unwrap_or(Level::Silent);
    Logger::new("test", level)
}

/// Start an isolated instance; `adjust` may change its configuration.
pub fn start_with(protocol: &'static str, adjust: impl FnOnce(&mut Config)) -> Instance {
    let cert = TempDir::new("reptile-cert-");
    let mut config = Config::from_args(&[]);
    config.protocol = protocol;
    config.host = "127.0.0.1".into();
    config.port = 0;
    config.port_attempts = 1;
    config.cert_dir = cert.0.clone();
    config.public_dir = None;
    config.allow_remote_ui = false;
    config.discovery.enabled = false;
    config.discovery.hosts = Some(vec!["127.0.0.1".into()]);
    config.discovery.ports = vec![];
    config.timing = FAST_TIMING;
    config.watcher = FAST_WATCHER;
    adjust(&mut config);
    let app = App::new(config, logger()).expect("start an instance");
    let port = app.listen().expect("listen");
    Instance { app, port, protocol, _cert: cert }
}

pub fn start(protocol: &'static str) -> Instance {
    start_with(protocol, |_| {})
}

/// Call an instance's HTTP API as the control panel would: `(status, body)`,
/// never failing on error statuses.
pub fn api(protocol: &str, port: u16, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    api_with(protocol, port, method, path, body, &[])
}

pub fn api_with(
    protocol: &str,
    port: u16,
    method: &str,
    path: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (u16, Value) {
    let target = Target::new(protocol, "127.0.0.1", port);
    let mut options = Options::get(path, 15_000);
    options.method = method;
    if let Some(body) = body {
        options.headers.push(("Content-Type".into(), "application/json".into()));
        options.body = Body::Bytes(body.to_string().into_bytes());
    }
    for (name, value) in headers {
        options.headers.push((name.to_string(), value.to_string()));
    }
    match request(&target, options) {
        Ok(response) => {
            let status = response.status;
            (status, response.json(64 * 1024 * 1024).unwrap_or(Value::Null))
        }
        Err(error) if error.status > 0 => {
            (error.status, json!({ "error": { "code": error.code, "message": error.message } }))
        }
        Err(error) => panic!("request failed: {error}"),
    }
}

impl Instance {
    pub fn api(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        api(self.protocol, self.port, method, path, body)
    }

    pub fn sync_state(&self) -> Option<&'static str> {
        self.app.syncing.engine().map(|engine| engine.state())
    }
}

/// Create files and directories: `("dir/", None)` is a directory.
pub fn write_tree(root: &Path, spec: &[(&str, Option<&str>)]) {
    for (path, content) in spec {
        let target = root.join(path.trim_end_matches('/'));
        match content {
            None => fs::create_dir_all(&target).unwrap(),
            Some(text) => {
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                fs::write(&target, text).unwrap();
            }
        }
    }
}

/// `{ "dir/": "dir", "dir/file": "<sha256 prefix>" }`, skipping Reptile's
/// temporary files and symlinks.
pub fn snapshot_tree(root: &Path) -> BTreeMap<String, String> {
    fn visit(directory: &Path, prefix: &str, out: &mut BTreeMap<String, String>) {
        let Ok(listing) = fs::read_dir(directory) else { return };
        let mut entries: Vec<_> = listing.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_temp_name(&name) {
                continue;
            }
            let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
            if meta.is_dir() {
                out.insert(format!("{relative}/"), "dir".into());
                visit(&entry.path(), &relative, out);
            } else if meta.is_file() {
                let bytes = fs::read(entry.path()).unwrap_or_default();
                out.insert(relative, hex(digest(&SHA256, &bytes).as_ref())[..16].to_string());
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, "", &mut out);
    out
}

/// Poll until `condition` holds, or fail the test.
pub fn wait_for(what: &str, timeout_ms: u64, condition: impl Fn() -> bool) {
    let started = Instant::now();
    while !condition() {
        if started.elapsed() > Duration::from_millis(timeout_ms) {
            panic!("timed out waiting for {what}");
        }
        sleep(Duration::from_millis(40));
    }
}

/// Wait until two trees are identical.
pub fn wait_same_trees(a: &Path, b: &Path, timeout_ms: u64) {
    let started = Instant::now();
    loop {
        let (left, right) = (snapshot_tree(a), snapshot_tree(b));
        if left == right {
            return;
        }
        if started.elapsed() > Duration::from_millis(timeout_ms) {
            panic!("trees did not converge\n  first:  {left:?}\n  second: {right:?}");
        }
        sleep(Duration::from_millis(50));
    }
}

/// A host and a syncing peer, connected and live.
pub struct Pair {
    pub host: Instance,
    pub client: Instance,
    pub host_dir: TempDir,
    pub sync_parent: TempDir,
    pub sync_dir: PathBuf,
}

pub fn connected_pair(
    protocol: &'static str,
    host_files: &[(&str, Option<&str>)],
    sync_files: Option<&[(&str, Option<&str>)]>,
    excluded: &[&str],
    pin: &str,
) -> Pair {
    connected_pair_with(protocol, host_files, sync_files, excluded, pin, |_, _| {})
}

/// `connected_pair`, with a chance to touch both directories before the
/// instances start (set mtimes, for instance).
pub fn connected_pair_with(
    protocol: &'static str,
    host_files: &[(&str, Option<&str>)],
    sync_files: Option<&[(&str, Option<&str>)]>,
    excluded: &[&str],
    pin: &str,
    prepare: impl FnOnce(&Path, &Path),
) -> Pair {
    let host_dir = TempDir::new("reptile-host-");
    let sync_parent = TempDir::new("reptile-sync-");
    let sync_dir = sync_parent.0.join("copy");
    write_tree(host_dir.path(), host_files);
    if let Some(files) = sync_files {
        fs::create_dir_all(&sync_dir).unwrap();
        write_tree(&sync_dir, files);
    }
    prepare(host_dir.path(), &sync_dir);
    let host = start(protocol);
    let client = start(protocol);
    host.app
        .modes
        .start_hosting(&json!({ "path": host_dir.text(), "name": "Shared", "pin": pin, "excluded": excluded }))
        .expect("host");
    client
        .app
        .modes
        .start_syncing(
            &json!({ "address": "127.0.0.1", "port": host.port, "localPath": sync_dir.to_string_lossy(), "pin": pin }),
        )
        .expect("sync");
    wait_for("the peer to go live", 15_000, || client.sync_state() == Some("live"));
    Pair { host, client, host_dir, sync_parent, sync_dir }
}

pub fn pair(host_files: &[(&str, Option<&str>)]) -> Pair {
    connected_pair("http", host_files, None, &[], "1234")
}
