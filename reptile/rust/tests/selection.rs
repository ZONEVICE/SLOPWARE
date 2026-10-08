//! The content selection: unchecked items never leave the host and are never
//! modified by the peer, whatever it asks for.

mod common;

use common::*;
use reptile::domain::hosting::HostingService;
use reptile::fs::entry::State;
use serde_json::{json, Value};
use std::fs;
use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

const FILES: &[(&str, Option<&str>)] = &[
    ("public.txt", Some("hello")),
    ("private.txt", Some("secret")),
    ("vault/key.pem", Some("KEY")),
    ("vault/sub/deep.txt", Some("deep")),
    ("mixed/ok.txt", Some("ok")),
    ("mixed/hidden.txt", Some("hidden")),
];
const EXCLUDED: &[&str] = &["private.txt", "vault", "mixed/hidden.txt"];

struct Session {
    _host: Instance,
    root: TempDir,
    hosting: Arc<HostingService>,
    token: String,
}

fn hosted_session() -> Session {
    let root = TempDir::new("reptile-sel-");
    write_tree(root.path(), FILES);
    let host = start("http");
    host.app
        .modes
        .start_hosting(&json!({ "path": root.text(), "name": "Selective", "pin": "1234", "excluded": EXCLUDED }))
        .unwrap();
    let hosting = host.app.hosting.clone();
    let answer = hosting
        .connect(
            Some(&json!("1234")),
            Some(&json!("http")),
            Some(&json!({ "uuid": "peer", "hostname": "peer" })),
            "127.0.0.1",
        )
        .unwrap();
    Session { token: answer["token"].as_str().unwrap().to_string(), root, hosting, _host: host }
}

fn listing(path: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> =
        fs::read_dir(path).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[test]
fn the_manifest_lists_only_checked_items() {
    let s = hosted_session();
    let manifest = s.hosting.manifest(&s.token).unwrap();
    let mut paths: Vec<&str> =
        manifest["entries"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap()).collect();
    paths.sort();
    assert_eq!(paths, vec!["mixed", "mixed/ok.txt", "public.txt"]);
}

#[test]
fn an_unchecked_file_cannot_be_downloaded() {
    let s = hosted_session();
    let refused = s.hosting.open_file(&s.token, Some(&json!("private.txt"))).err().unwrap();
    assert_eq!((refused.code.as_str(), refused.status), ("not_shared", 403));
    assert_eq!(s.hosting.open_file(&s.token, Some(&json!("vault/sub/deep.txt"))).err().unwrap().code, "not_shared");
    assert_eq!(s.hosting.open_file(&s.token, Some(&json!("public.txt"))).ok().unwrap().state.size, 5);
}

#[test]
fn unchecked_items_cannot_be_written_deleted_renamed_or_created_from_the_other_side() {
    let s = hosted_session();
    for path in ["private.txt", "vault/new.txt"] {
        let error =
            s.hosting.prepare_upload(&s.token, Some(&json!(path)), 1.0, 1_700_000_000_000.0, None).err().unwrap();
        assert_eq!(error.code, "not_shared");
    }
    let result = s
        .hosting
        .apply_ops(
            &s.token,
            Some(&json!([
                { "op": "unlink", "path": "private.txt" },
                { "op": "rmdir", "path": "vault" },
                { "op": "rename", "from": "mixed/hidden.txt", "to": "exposed.txt" },
                { "op": "rename", "from": "public.txt", "to": "vault/public.txt" },
                { "op": "mkdir", "path": "vault/new" },
            ])),
        )
        .unwrap();
    let codes: Vec<&str> =
        result["results"].as_array().unwrap().iter().map(|r| r["code"].as_str().unwrap_or("")).collect();
    assert_eq!(codes, vec!["not_shared"; 5]);
    let read = |p: &str| fs::read_to_string(s.root.path().join(p)).unwrap();
    assert_eq!(read("private.txt"), "secret");
    assert_eq!(read("vault/sub/deep.txt"), "deep");
    assert_eq!(read("mixed/hidden.txt"), "hidden");
    assert_eq!(read("public.txt"), "hello");
}

#[test]
fn deleting_a_checked_directory_leaves_its_unchecked_content_in_place() {
    let s = hosted_session();
    let result = s.hosting.apply_ops(&s.token, Some(&json!([{ "op": "rmdir", "path": "mixed" }]))).unwrap();
    assert_eq!(result["results"][0]["ok"], true);
    assert_eq!(result["results"][0]["partial"], true, "the peer learns the directory could not go away");
    assert_eq!(listing(&s.root.path().join("mixed")), vec!["hidden.txt"]);
}

#[test]
fn renaming_a_checked_directory_moves_only_its_checked_content() {
    let s = hosted_session();
    let result = s
        .hosting
        .apply_ops(&s.token, Some(&json!([{ "op": "rename", "from": "mixed", "to": "renamed", "kind": "dir" }])))
        .unwrap();
    assert_eq!(result["results"][0]["ok"], true);
    assert_eq!(listing(&s.root.path().join("renamed")), vec!["ok.txt"]);
    assert_eq!(listing(&s.root.path().join("mixed")), vec!["hidden.txt"], "the unchecked file did not move");
}

#[test]
fn a_checked_file_can_be_uploaded_next_to_unchecked_ones() {
    let s = hosted_session();
    let prepared =
        s.hosting.prepare_upload(&s.token, Some(&json!("mixed/new.txt")), 3.0, 1_700_000_000_000.0, None).ok().unwrap();
    s.hosting.receive_file(prepared, &mut &b"new"[..], 3, 1_700_000_000_000).unwrap();
    assert_eq!(fs::read_to_string(s.root.path().join("mixed/new.txt")).unwrap(), "new");
    let _: Option<State> = None;
}

#[test]
fn unchecked_items_never_reach_the_other_side_before_or_after_connecting() {
    let pair = connected_pair(
        "http",
        &[("shared.txt", Some("s")), ("private.txt", Some("p")), ("vault/x.txt", Some("x"))],
        None,
        &["private.txt", "vault"],
        "1234",
    );
    wait_for("the shared file", 10_000, || pair.sync_dir.join("shared.txt").exists());
    fs::write(pair.host_dir.path().join("vault/later.txt"), "later").unwrap();
    fs::write(pair.host_dir.path().join("later-shared.txt"), "yes").unwrap();
    wait_for("the later shared file", 10_000, || pair.sync_dir.join("later-shared.txt").exists());
    sleep(Duration::from_millis(500));
    assert_eq!(listing(&pair.sync_dir), vec!["later-shared.txt", "shared.txt"]);
}

#[test]
fn an_unchecked_file_renamed_on_the_host_stays_unchecked() {
    let pair = connected_pair(
        "http",
        &[("shared.txt", Some("s")), ("secret.txt", Some("top secret"))],
        None,
        &["secret.txt"],
        "1234",
    );
    fs::rename(pair.host_dir.path().join("secret.txt"), pair.host_dir.path().join("renamed-secret.txt")).unwrap();
    fs::write(pair.host_dir.path().join("marker.txt"), "m").unwrap();
    wait_for("the marker", 10_000, || pair.sync_dir.join("marker.txt").exists());
    sleep(Duration::from_millis(800));
    let names = listing(&pair.sync_dir);
    assert!(
        !names.contains(&"renamed-secret.txt".to_string()) && !names.contains(&"secret.txt".to_string()),
        "leaked: {names:?}"
    );
}

#[test]
fn an_unchecked_directory_renamed_on_the_host_stays_unchecked_content_included() {
    let pair = connected_pair(
        "http",
        &[("shared.txt", Some("s")), ("private/a.txt", Some("a")), ("private/b/c.txt", Some("c"))],
        None,
        &["private"],
        "1234",
    );
    fs::rename(pair.host_dir.path().join("private"), pair.host_dir.path().join("public-now")).unwrap();
    fs::write(pair.host_dir.path().join("marker.txt"), "m").unwrap();
    wait_for("the marker", 10_000, || pair.sync_dir.join("marker.txt").exists());
    sleep(Duration::from_millis(800));
    assert!(!listing(&pair.sync_dir).contains(&"public-now".to_string()));
}

#[test]
fn a_file_the_peer_creates_inside_an_unchecked_directory_is_refused_and_reported() {
    let pair =
        connected_pair("http", &[("shared.txt", Some("s")), ("vault/x.txt", Some("x"))], None, &["vault"], "1234");
    write_tree(&pair.sync_dir, &[("vault/mine.txt", Some("from the peer"))]);
    wait_for("the refusal to be reported", 10_000, || {
        !pair.client.app.syncing.status()["rejected"].as_array().map(Vec::is_empty).unwrap_or(true)
    });
    assert_eq!(listing(&pair.host_dir.path().join("vault")), vec!["x.txt"]);
    let rejected: Vec<Value> = pair.client.app.syncing.status()["rejected"].as_array().unwrap().clone();
    assert!(rejected.iter().any(|p| p.as_str().unwrap().starts_with("vault")));
}
