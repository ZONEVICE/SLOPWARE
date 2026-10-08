//! Connection rules and the PIN.
//!
//!  - one hosted directory, one connected instance, whatever PIN it brings;
//!  - HTTP only talks to HTTP and HTTPS only to HTTPS;
//!  - stopping hosting, a clean shutdown and a crash are told apart;
//!  - an instance is in one mode at a time;
//!  - the PIN: right, wrong (retried without limit), changed while connected.

mod common;

use common::*;
use reptile::domain::identity::{system_interfaces, Identity};
use reptile::domain::transport::PeerApi;
use reptile::peer::client::PeerClient;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

struct Hosting {
    host: Instance,
    root: TempDir,
}

fn hosting_with(protocol: &'static str, pin: &str, name: &str) -> Hosting {
    let root = TempDir::new("reptile-host-");
    fs::write(root.path().join("file.txt"), "content").unwrap();
    let host = start(protocol);
    host.app.modes.start_hosting(&json!({ "path": root.text(), "name": name, "pin": pin })).unwrap();
    Hosting { host, root }
}

fn hosting() -> Hosting {
    hosting_with("http", "1234", "Shared")
}

fn sync_body(port: u16, local: &Path, pin: &str) -> Value {
    json!({ "address": "127.0.0.1", "port": port, "localPath": local.to_string_lossy(), "pin": pin })
}

fn ghost(port: u16, identity: &Arc<Identity>) -> PeerClient {
    PeerClient::new("127.0.0.1", port, "http", identity.clone(), FAST_TIMING)
}

// --- One connection per hosted directory ----------------------------------------------

#[test]
fn a_second_instance_is_refused_even_with_the_right_pin() {
    let pair = pair(&[("a.txt", Some("a"))]);
    let intruder = start("http");
    let local = TempDir::new("reptile-x-");
    let (status, body) = intruder.api("POST", "/api/sync", Some(sync_body(pair.host.port, &local.0.join("x"), "1234")));
    assert_eq!(status, 409);
    assert_eq!(body["error"]["code"], "busy");
    let message = body["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("already being synced by") && message.contains("only one connected instance"),
        "{message}"
    );
    assert_eq!(intruder.app.modes.mode(), "idle");
    assert_eq!(pair.client.sync_state(), Some("live"), "the connected peer is not disturbed");
}

#[test]
fn the_discovery_answer_says_the_directory_is_busy() {
    let pair = pair(&[]);
    let (_, ping) = pair.host.api("GET", "/api/ping", None);
    assert_eq!(ping["hosting"]["connected"], true);
}

#[test]
fn once_the_peer_leaves_another_instance_can_connect() {
    let pair = pair(&[]);
    pair.client.api("DELETE", "/api/sync", None);
    wait_for("the host to free the slot", 5000, || pair.host.app.hosting.status()["session"].is_null());
    let next = start("http");
    let local = TempDir::new("reptile-n-");
    let (status, _) = next.api("POST", "/api/sync", Some(sync_body(pair.host.port, &local.0.join("n"), "1234")));
    assert_eq!(status, 201);
}

#[test]
fn a_peer_that_vanishes_without_goodbye_frees_the_slot_after_a_timeout() {
    let hosting = hosting();
    let identity = Arc::new(Identity::new("http", system_interfaces()));
    let peer = ghost(hosting.host.port, &identity);
    peer.connect("1234", "/nowhere").unwrap();
    assert!(!hosting.host.app.hosting.status()["session"].is_null());
    peer.close(); // no heartbeats, no disconnect
    wait_for("the silent peer to be dropped", 6000, || hosting.host.app.hosting.status()["session"].is_null());
}

#[test]
fn the_same_instance_reconnecting_replaces_its_own_previous_session() {
    let hosting = hosting();
    let identity = Arc::new(Identity::new("http", system_interfaces()));
    let (first, second) = (ghost(hosting.host.port, &identity), ghost(hosting.host.port, &identity));
    let a = first.connect("1234", "/a").unwrap();
    let b = second.connect("1234", "/a").unwrap();
    assert_ne!(a["token"], b["token"]);
    assert_eq!(first.manifest().unwrap_err().status, 401);
    assert!(!second.manifest().unwrap()["entries"].as_array().unwrap().is_empty());
}

// --- Protocols must match -----------------------------------------------------------------

#[test]
fn an_http_instance_cannot_sync_from_an_https_one() {
    let hosting = hosting_with("https", "1234", "Shared");
    let client = start("http");
    let local = TempDir::new("reptile-x-");
    let (status, body) =
        client.api("POST", "/api/sync", Some(sync_body(hosting.host.port, &local.0.join("x"), "1234")));
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "protocol_mismatch");
    assert!(body["error"]["message"].as_str().unwrap().contains("HTTPS"));
    let (_, inspect) =
        client.api("POST", "/api/sync/inspect", Some(json!({ "address": "127.0.0.1", "port": hosting.host.port })));
    assert_eq!(inspect["compatible"], false);
}

#[test]
fn an_https_instance_cannot_sync_from_an_http_one() {
    let hosting = hosting();
    let client = start("https");
    let local = TempDir::new("reptile-x-");
    let (status, body) =
        client.api("POST", "/api/sync", Some(sync_body(hosting.host.port, &local.0.join("x"), "1234")));
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "protocol_mismatch");
}

#[test]
fn the_host_refuses_a_peer_that_declares_another_protocol() {
    let hosting = hosting();
    let error = hosting
        .host
        .app
        .hosting
        .connect(
            Some(&json!("1234")),
            Some(&json!("https")),
            Some(&json!({ "uuid": "x", "hostname": "x" })),
            "127.0.0.1",
        )
        .unwrap_err();
    assert_eq!(error.code, "protocol_mismatch");
}

// --- Ending a session ----------------------------------------------------------------------

#[test]
fn stopping_hosting_disconnects_the_peer_and_tells_it_why() {
    let pair = pair(&[("a.txt", Some("a"))]);
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 10_000);
    pair.host.api("DELETE", "/api/host", None);
    wait_for("the peer to learn hosting stopped", 5000, || pair.client.sync_state() == Some("stopped"));
    assert!(pair.client.app.syncing.status()["notice"]["message"].as_str().unwrap().contains("stopped hosting"));
    assert_eq!(pair.client.app.modes.mode(), "syncing", "the notice stays visible until the user leaves");
    fs::write(pair.host_dir.path().join("after-stop.txt"), "x").unwrap();
    sleep(Duration::from_millis(500));
    let names: Vec<String> =
        fs::read_dir(&pair.sync_dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec!["a.txt"]);
    let (status, _) = pair.client.api("DELETE", "/api/sync", None);
    assert_eq!(status, 200);
    assert_eq!(pair.client.app.modes.mode(), "idle");
}

#[test]
fn a_host_process_that_shuts_down_cleanly_says_goodbye() {
    let pair = pair(&[]);
    pair.host.app.close();
    wait_for("the peer to be told", 5000, || pair.client.sync_state() == Some("stopped"));
}

#[test]
fn a_peer_notices_a_host_that_crashes_and_keeps_trying_to_reconnect() {
    let pair = pair(&[]);
    // No goodbye: the server just vanishes, as with a crash or a pulled cable.
    pair.host.app.kill_connections();
    wait_for("the peer to notice", 5000, || pair.client.sync_state() == Some("reconnecting"));
    wait_for("repeated attempts", 8000, || {
        pair.client.app.syncing.status()["reconnect"]["attempt"].as_u64().unwrap_or(0) >= 2
    });
    let notice = pair.client.app.syncing.status()["notice"]["message"].as_str().unwrap_or("").to_string();
    assert!(notice.contains("Retrying") || notice.contains("Reconnecting"), "{notice}");
}

#[test]
fn a_reconciliation_pending_from_before_a_drop_does_not_stall_the_new_connection() {
    let pair = pair(&[("a.txt", Some("a"))]);
    // A retry scheduled far in the future, as after a conflict...
    pair.client.app.syncing.engine().unwrap().schedule_reconcile(60_000);
    // ...then the connection drops and comes back.
    pair.host.app.drop_connections();
    wait_for("the drop to be noticed", 5000, || pair.client.sync_state() != Some("live"));
    wait_for("live again without waiting for the old timer", 8000, || pair.client.sync_state() == Some("live"));
}

#[test]
fn a_peer_resumes_on_its_own_after_a_network_interruption() {
    let pair = pair(&[("a.txt", Some("a"))]);
    pair.host.app.drop_connections();
    wait_for("the drop to be noticed", 5000, || matches!(pair.client.sync_state(), Some("reconnecting" | "syncing")));
    wait_for("the automatic reconnection", 10_000, || pair.client.sync_state() == Some("live"));
    fs::write(pair.host_dir.path().join("after-reconnect.txt"), "ok").unwrap();
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 10_000);
}

// --- One mode at a time ----------------------------------------------------------------------

#[test]
fn an_instance_cannot_sync_from_itself() {
    let hosting = hosting();
    let local = TempDir::new("reptile-x-");
    let (_, body) =
        hosting.host.api("POST", "/api/sync", Some(sync_body(hosting.host.port, &local.0.join("x"), "1234")));
    assert_eq!(body["error"]["code"], "self");
    assert_eq!(hosting.host.app.modes.mode(), "hosting");
}

#[test]
fn switching_to_sync_stops_hosting_but_only_after_the_pin_was_accepted() {
    let target = hosting_with("http", "1234", "Target");
    let switcher = hosting_with("http", "1234", "Mine");
    let local = TempDir::new("reptile-copy-");
    let path = local.0.join("copy");
    let (status, _) = switcher.host.api("POST", "/api/sync", Some(sync_body(target.host.port, &path, "0000")));
    assert_eq!(status, 403);
    assert_eq!(switcher.host.app.modes.mode(), "hosting", "a wrong PIN leaves hosting untouched");
    let (status, _) = switcher.host.api("POST", "/api/sync", Some(sync_body(target.host.port, &path, "1234")));
    assert_eq!(status, 201);
    assert_eq!(switcher.host.app.modes.mode(), "syncing");
    assert!(!switcher.host.app.hosting.active(), "hosting was cancelled");
    let (_, ping) = switcher.host.api("GET", "/api/ping", None);
    assert!(ping["hosting"].is_null());
}

#[test]
fn hosting_while_syncing_stops_syncing_first() {
    let pair = pair(&[]);
    let other = TempDir::new("reptile-new-");
    let (status, _) =
        pair.client.api("POST", "/api/host", Some(json!({ "path": other.text(), "name": "New", "pin": "1111" })));
    assert_eq!(status, 201);
    assert_eq!(pair.client.app.modes.mode(), "hosting");
    assert!(!pair.client.app.syncing.active());
    wait_for("the old host to see the peer leave", 5000, || pair.host.app.hosting.status()["session"].is_null());
}

#[test]
fn hosting_another_directory_requires_cancelling_the_current_one_first() {
    let hosting = hosting();
    let (a, b) = (TempDir::new("reptile-a-"), TempDir::new("reptile-b-"));
    let (status, body) = hosting.host.api("POST", "/api/host", Some(json!({ "path": a.text(), "pin": "1111" })));
    assert_eq!(status, 409);
    assert_eq!(body["error"]["code"], "already_hosting");
    hosting.host.api("DELETE", "/api/host", None);
    let (status, _) = hosting.host.api("POST", "/api/host", Some(json!({ "path": b.text(), "pin": "1111" })));
    assert_eq!(status, 201);
}

#[test]
fn a_directory_cannot_be_synced_into_itself_on_the_same_computer() {
    let hosting = hosting();
    let client = start("http");
    let (_, body) =
        client.api("POST", "/api/sync", Some(sync_body(hosting.host.port, &hosting.root.0.join("inside"), "1234")));
    assert_eq!(body["error"]["code"], "same_directory");
}

#[test]
fn syncing_needs_a_target_that_is_actually_hosting() {
    let idle = start("http");
    let client = start("http");
    let local = TempDir::new("reptile-x-");
    let (status, body) = client.api("POST", "/api/sync", Some(sync_body(idle.port, &local.0.join("x"), "1234")));
    assert_eq!(status, 409);
    assert_eq!(body["error"]["code"], "not_hosting");
}

// --- The PIN ------------------------------------------------------------------------------------

#[test]
fn a_wrong_pin_is_refused_and_can_be_retried_without_limit() {
    let hosting = hosting_with("http", "4321", "Guarded");
    let client = start("http");
    let local = TempDir::new("reptile-copy-");
    let path = local.0.join("copy");
    for attempt in 0..25 {
        let (status, body) =
            client.api("POST", "/api/sync", Some(sync_body(hosting.host.port, &path, &format!("{}", 1000 + attempt))));
        assert_eq!(status, 403);
        assert_eq!(body["error"]["code"], "pin_invalid");
        assert!(body["error"]["message"].as_str().unwrap().contains("Wrong PIN"));
    }
    assert_eq!(client.app.modes.mode(), "idle", "a refused PIN changes nothing");
    let (status, _) = client.api("POST", "/api/sync", Some(sync_body(hosting.host.port, &path, "4321")));
    assert_eq!(status, 201);
    wait_for("live", 10_000, || client.sync_state() == Some("live"));
}

#[test]
fn a_pin_must_be_exactly_four_digits_and_one_is_generated_when_missing() {
    let hosting = hosting();
    let client = start("http");
    let local = TempDir::new("reptile-c-");
    let (status, body) =
        client.api("POST", "/api/sync", Some(sync_body(hosting.host.port, &local.0.join("c"), "12a4")));
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "pin_format");
    let instance = start("http");
    let dir = TempDir::new("reptile-p-");
    let (_, bad) = instance.api("POST", "/api/host", Some(json!({ "path": dir.text(), "pin": "12345" })));
    assert_eq!(bad["error"]["code"], "pin_format");
    let (status, started) = instance.api("POST", "/api/host", Some(json!({ "path": dir.text() })));
    assert_eq!(status, 201);
    assert_eq!(started["pin"].as_str().unwrap().len(), 4);
    let (_, suggestion) = instance.api("GET", "/api/host/pin/suggest", None);
    assert_eq!(suggestion["pin"].as_str().unwrap().len(), 4);
}

#[test]
fn changing_the_pin_without_a_peer_and_random_pins_always_differ() {
    let hosting = hosting_with("http", "1111", "Guarded");
    let (_, answer) = hosting.host.api("POST", "/api/host/pin", Some(json!({ "pin": "2222" })));
    assert_eq!(answer, json!({ "pin": "2222", "changed": true, "disconnected": false }));
    for _ in 0..20 {
        let before = hosting.host.app.hosting.status()["pin"].clone();
        let (_, answer) = hosting.host.api("POST", "/api/host/pin", Some(json!({})));
        assert_ne!(answer["pin"], before);
    }
}

#[test]
fn the_old_pin_stops_working_and_the_new_one_works() {
    let hosting = hosting_with("http", "1111", "Guarded");
    hosting.host.api("POST", "/api/host/pin", Some(json!({ "pin": "9999" })));
    let client = start("http");
    let local = TempDir::new("reptile-copy-");
    let path = local.0.join("copy");
    let (_, old) = client.api("POST", "/api/sync", Some(sync_body(hosting.host.port, &path, "1111")));
    assert_eq!(old["error"]["code"], "pin_invalid");
    let (status, _) = client.api("POST", "/api/sync", Some(sync_body(hosting.host.port, &path, "9999")));
    assert_eq!(status, 201);
}

#[test]
fn a_pin_change_cuts_the_peer_off_and_the_new_pin_resumes_with_everything_from_the_pause() {
    let pair = connected_pair("http", &[("a.txt", Some("a"))], None, &[], "1234");
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 10_000);
    let (_, changed) = pair.host.api("POST", "/api/host/pin", Some(json!({ "pin": "5678" })));
    assert_eq!(changed["disconnected"], true);
    assert!(pair.host.app.hosting.status()["session"].is_null(), "the host dropped the session immediately");
    wait_for("the peer to ask for the PIN", 5000, || pair.client.sync_state() == Some("pin_required"));
    assert!(pair.client.app.syncing.status()["notice"]["message"].as_str().unwrap().contains("changed the PIN"));

    // While paused, nothing flows.
    fs::write(pair.host_dir.path().join("during-pause-host.txt"), "h").unwrap();
    fs::write(pair.sync_dir.join("during-pause-peer.txt"), "p").unwrap();
    fs::remove_file(pair.sync_dir.join("a.txt")).unwrap();
    sleep(Duration::from_millis(700));
    assert!(!pair.sync_dir.join("during-pause-host.txt").exists());

    for wrong in ["1234", "0000"] {
        let (status, body) = pair.client.api("POST", "/api/sync/pin", Some(json!({ "pin": wrong })));
        assert_eq!(status, 403);
        assert_eq!(body["error"]["code"], "pin_invalid");
        assert_eq!(pair.client.sync_state(), Some("pin_required"));
    }
    let (status, _) = pair.client.api("POST", "/api/sync/pin", Some(json!({ "pin": "5678" })));
    assert_eq!(status, 200);
    wait_for("the sync to resume", 10_000, || pair.client.sync_state() == Some("live"));

    // Both sides' changes are exchanged, and the deletion made here is
    // understood as a deletion, not undone.
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 10_000);
    assert_eq!(fs::read_to_string(pair.host_dir.path().join("during-pause-peer.txt")).unwrap(), "p");
    assert_eq!(fs::read_to_string(pair.sync_dir.join("during-pause-host.txt")).unwrap(), "h");
    assert!(!pair.host_dir.path().join("a.txt").exists());
    fs::write(pair.host_dir.path().join("after.txt"), "after").unwrap();
    wait_for("live sync afterwards", 10_000, || {
        fs::read_to_string(pair.sync_dir.join("after.txt")).unwrap_or_default() == "after"
    });
}

#[test]
fn a_pin_is_only_asked_for_when_one_is_needed() {
    let pair = pair(&[("a.txt", Some("a"))]);
    let (status, body) = pair.client.api("POST", "/api/sync/pin", Some(json!({ "pin": "1234" })));
    assert_eq!(status, 409);
    assert_eq!(body["error"]["code"], "pin_not_needed");
}
