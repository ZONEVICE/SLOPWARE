//! HTTPS end to end: each instance mints a brand-new self-signed certificate
//! at startup; instances accept each other's and pin the one seen when the
//! session opens.

mod common;

use common::*;
use reptile::domain::identity::{system_interfaces, Identity};
use reptile::domain::transport::PeerApi;
use reptile::http::client::{request, Options, Target};
use reptile::peer::client::PeerClient;
use serde_json::json;
use std::fs;
use std::sync::Arc;

#[test]
fn initial_and_live_synchronisation_work_in_both_directions() {
    let pair = connected_pair(
        "https",
        &[("a.txt", Some("alpha")), ("docs/b.md", Some("bravo")), ("private.txt", Some("no"))],
        Some(&[("from-peer.txt", Some("peer"))]),
        &["private.txt"],
        "1234",
    );
    assert_eq!(pair.host.app.identity.protocol, "https");
    assert_eq!(pair.client.app.syncing.status()["protocol"], "https");
    wait_for("the peer's file", 10_000, || pair.host_dir.path().join("from-peer.txt").exists());
    fs::write(pair.host_dir.path().join("host-new.txt"), "h").unwrap();
    fs::write(pair.sync_dir.join("peer-new.txt"), "p").unwrap();
    fs::rename(pair.sync_dir.join("docs"), pair.sync_dir.join("documents")).unwrap();
    fs::remove_file(pair.host_dir.path().join("a.txt")).unwrap();
    wait_for("convergence", 15_000, || {
        let mut host = snapshot_tree(pair.host_dir.path());
        host.remove("private.txt");
        host == snapshot_tree(&pair.sync_dir)
    });
    assert_eq!(fs::read_to_string(pair.host_dir.path().join("documents/b.md")).unwrap(), "bravo");
    assert!(!pair.sync_dir.join("private.txt").exists());
}

#[test]
fn the_pin_change_flow_works_over_https_too() {
    let pair = connected_pair("https", &[("x.txt", Some("x"))], None, &[], "1234");
    pair.host.api("POST", "/api/host/pin", Some(json!({ "pin": "8888" })));
    wait_for("pin_required", 5000, || pair.client.sync_state() == Some("pin_required"));
    let (status, _) = pair.client.api("POST", "/api/sync/pin", Some(json!({ "pin": "8888" })));
    assert_eq!(status, 200);
    wait_for("live", 10_000, || pair.client.sync_state() == Some("live"));
    fs::write(pair.host_dir.path().join("y.txt"), "y").unwrap();
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 10_000);
}

#[test]
fn the_host_certificate_is_pinned_for_the_whole_session() {
    let root = TempDir::new("reptile-pin-");
    fs::write(root.path().join("f.txt"), "f").unwrap();
    let host = start("https");
    host.app.modes.start_hosting(&json!({ "path": root.text(), "name": "Pinned", "pin": "1234" })).unwrap();
    let identity = Arc::new(Identity::new("https", system_interfaces()));
    let peer = PeerClient::new("127.0.0.1", host.port, "https", identity, FAST_TIMING);
    peer.connect("1234", "/elsewhere").unwrap();
    assert_eq!(peer.fingerprint(), Some(host.app.tls.as_ref().unwrap().fingerprint256.clone()));
    assert_eq!(peer.manifest().unwrap()["entries"].as_array().unwrap().len(), 1);
    peer.close();
}

#[test]
fn a_certificate_change_mid_session_is_refused() {
    let host = start("https");
    let other = start("https");
    let target = Target::new("https", "127.0.0.1", host.port);
    let mut options = Options::get("/api/ping", 5000);
    options.fingerprint = Some(other.app.tls.as_ref().unwrap().fingerprint256.clone());
    assert_eq!(request(&target, options).err().unwrap().code, "certificate_changed");
    let mut options = Options::get("/api/ping", 5000);
    options.fingerprint = Some(host.app.tls.as_ref().unwrap().fingerprint256.clone());
    let answer = request(&target, options).unwrap().json(64 * 1024).unwrap();
    assert_eq!(answer["protocol"], "https");
}

#[test]
fn every_start_mints_a_new_certificate_and_replaces_the_files() {
    let directory = TempDir::new("reptile-certs-");
    let first = start_with("https", |config| config.cert_dir = directory.0.clone());
    let pem_one = fs::read_to_string(directory.path().join("cert.pem")).unwrap();
    assert!(pem_one.starts_with("-----BEGIN CERTIFICATE-----"));
    assert!(fs::read_to_string(directory.path().join("key.pem")).unwrap().starts_with("-----BEGIN PRIVATE KEY-----"));
    let second = start_with("https", |config| config.cert_dir = directory.0.clone());
    let pem_two = fs::read_to_string(directory.path().join("cert.pem")).unwrap();
    assert_ne!(pem_one, pem_two, "replaced on every start");
    let fp = |instance: &Instance| instance.app.tls.as_ref().unwrap().fingerprint256.clone();
    assert_ne!(fp(&first), fp(&second));
    // Each process keeps serving the certificate it generated.
    for instance in [&first, &second] {
        let (status, ping) = instance.api("GET", "/api/ping", None);
        assert_eq!((status, ping["protocol"].as_str()), (200, Some("https")));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(directory.path().join("key.pem")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the private key is private");
    }
}
