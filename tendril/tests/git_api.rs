//! Git over HTTP, against the host's real `git` (skipped where it is not
//! installed): a folder that is not a repository, then a round of local work
//! (status, staging, diffs, commit, branches), and the confinement of paths.

mod common;

use std::path::Path;
use std::process::Command;

use common::{Server, enc};
use serde_json::json;
use tendril::config::cli::Scheme;

fn have_git() -> bool {
    Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn a_folder_that_is_not_a_repository_says_so() {
    if !have_git() {
        return;
    }
    let server = Server::start(Scheme::Http);
    let client = server.session();
    let status = client.get("/api/git/status");
    assert_eq!(status.status, 200);
    let body = status.json();
    assert_eq!((body["available"].as_bool(), body["repo"].as_bool()), (Some(true), Some(false)), "{body}");
    assert_eq!(client.post_json("/api/git/stage", &json!({ "paths": ["a.txt"] })).status, 404);
}

#[test]
fn a_round_of_local_work() {
    if !have_git() {
        return;
    }
    let server = Server::start(Scheme::Http);
    let dir = server.workspace.path();
    git(dir, &["init", "--quiet", "--initial-branch=main"]);
    git(dir, &["config", "user.name", "Tendril Test"]);
    git(dir, &["config", "user.email", "test@example.invalid"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
    server.write("tracked.txt", "one\n");
    git(dir, &["add", "tracked.txt"]);
    git(dir, &["commit", "--quiet", "-m", "start"]);
    server.write("tracked.txt", "one\ntwo\n");
    server.write("new.txt", "fresh\n");
    let client = server.session();

    let body = client.get("/api/git/status").json();
    assert_eq!(body["branch"], "main", "{body}");
    let files = body["files"].as_array().unwrap();
    let find = |path: &str| files.iter().find(|f| f["path"] == path).cloned().unwrap_or_default();
    assert_eq!(find("tracked.txt")["unstaged"], "M");
    assert_eq!(find("new.txt")["unstaged"], "U");

    // The diff's original side: the committed text, as the editor shows it.
    let head = client.get(&format!("/api/git/show?path={}&ref=HEAD", enc("tracked.txt")));
    assert_eq!((head.status, head.text()), (200, "one\n".to_string()));
    let missing = client.get(&format!("/api/git/show?path={}&ref=HEAD", enc("new.txt")));
    assert_eq!((missing.status, missing.header("x-tendril-exists")), (200, Some("0")));

    // Paths stay inside the workspace.
    for bad in ["../outside.txt", "/../x", "sub/../../x"] {
        let response = client.post_json("/api/git/stage", &json!({ "paths": [bad] }));
        assert!(response.status == 400 || response.status == 403, "{bad}: {}", response.status);
    }
    assert_eq!(client.get(&format!("/api/git/show?path={}&ref=HEAD", enc("../x"))).status / 100, 4);

    assert_eq!(client.post_json("/api/git/stage", &json!({ "paths": ["tracked.txt", "new.txt"] })).status, 200);
    let staged = client.get("/api/git/show?path=tracked.txt&ref=INDEX");
    assert_eq!(staged.text(), "one\ntwo\n");
    assert_eq!(client.post_json("/api/git/unstage", &json!({ "paths": ["new.txt"] })).status, 200);
    let commit = client.post_json("/api/git/commit", &json!({ "message": "Add two" }));
    assert_eq!(commit.status, 200, "{}", commit.text());
    assert!(commit.json()["summary"].as_str().unwrap().contains("Add two"));
    let empty = client.post_json("/api/git/commit", &json!({ "message": "  " }));
    assert_eq!(empty.status, 400);

    let body = client.get("/api/git/status").json();
    let files = body["files"].as_array().unwrap();
    assert!(!files.iter().any(|f| f["path"] == "tracked.txt"), "{body}");
    assert!(files.iter().any(|f| f["path"] == "new.txt"));

    // Branches: create, list, switch back; a bad name never reaches git.
    assert_eq!(client.post_json("/api/git/branch", &json!({ "name": "feature/demo" })).status, 200);
    assert_eq!(client.post_json("/api/git/branch", &json!({ "name": "--force" })).status, 400);
    let branches = client.get("/api/git/branches").json();
    assert_eq!(branches["current"], "feature/demo");
    assert_eq!(client.post_json("/api/git/checkout", &json!({ "branch": "main" })).status, 200);
    assert_eq!(client.get("/api/git/status").json()["branch"], "main");

    // Nothing to push to: git's refusal comes back, quickly.
    let push = client.post_json("/api/git/push", &json!({}));
    assert_eq!(push.status, 400, "{}", push.text());

    // The log records the operations, not their details.
    server.state.logger.flush();
    let logs = std::fs::read_dir(server.data.path().join(".tendril/logs")).unwrap();
    let text: String = logs.map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap()).collect();
    assert!(text.contains(r#""event":"git""#) && text.contains(r#""op":"commit""#));
    assert!(!text.contains("Add two"), "commit messages are not logged");
}
