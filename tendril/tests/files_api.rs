//! The workspace file API over HTTP: confinement, reading and writing text
//! with its encoding details, conflicts, file operations, uploads, raw
//! downloads with ranges, search, and the folder picker.

mod common;

use common::{Server, enc};
use serde_json::json;
use tendril::config::cli::Scheme;

#[test]
fn traversal_attempts_never_leave_the_workspace() {
    let server = Server::start(Scheme::Http);
    // A secret next to the workspace.
    let secret = server
        .workspace
        .path()
        .parent()
        .unwrap()
        .join(format!("{}-secret.txt", server.workspace.path().file_name().unwrap().to_string_lossy()));
    std::fs::write(&secret, "TOP SECRET").unwrap();
    let secret_name = secret.file_name().unwrap().to_string_lossy().into_owned();
    server.write("inside.txt", "hello");
    let client = server.session();

    let attempts = [
        format!("../{secret_name}"),
        format!("..%2F{secret_name}"),
        format!("%2e%2e/{secret_name}"),
        format!("%2E%2E%2F{secret_name}"),
        format!("sub/../../{secret_name}"),
        format!("./../{secret_name}"),
        "..".to_string(),
        secret.to_string_lossy().into_owned(),
        "/etc/passwd".to_string(),
        "%252e%252e/etc/passwd".to_string(),
        format!("..\\{secret_name}"),
        "C:\\Windows\\win.ini".to_string(),
    ];
    for attempt in attempts {
        // Some attempts are already encoded; encode the rest.
        let query = if attempt.contains('%') { attempt.clone() } else { enc(&attempt) };
        for endpoint in ["/api/fs/read", "/api/fs/raw", "/api/fs/stat", "/api/fs/list"] {
            let response = client.get(&format!("{endpoint}?path={query}"));
            assert_ne!(response.status, 200, "{endpoint} {attempt} -> {}", response.text());
            assert!(!response.text().contains("TOP SECRET"), "{endpoint} {attempt} leaked the secret");
        }
        let write = client.request("PUT", &format!("/api/fs/write?path={query}"), &[], b"overwritten");
        assert_ne!(write.status, 200, "write {attempt} -> {}", write.text());
    }
    assert_eq!(std::fs::read_to_string(&secret).unwrap(), "TOP SECRET");
    std::fs::remove_file(secret).unwrap();
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_escape_the_workspace() {
    let server = Server::start(Scheme::Http);
    let outside = common::TempDir::new("outside");
    std::fs::write(outside.path().join("passwd"), "root:x:0:0").unwrap();
    std::os::unix::fs::symlink(outside.path(), server.workspace.path().join("escape")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("passwd"), server.workspace.path().join("link.txt")).unwrap();
    let client = server.session();
    for path in ["escape/passwd", "link.txt"] {
        let response = client.get(&format!("/api/fs/read?path={}", enc(path)));
        assert_eq!(response.status, 403, "{path}: {}", response.text());
        assert_eq!(response.json()["error"], "outside_workspace");
    }
    let write = client.request("PUT", "/api/fs/write?path=escape/new.txt", &[], b"x");
    assert_eq!(write.status, 403);
    assert!(!outside.path().join("new.txt").exists());
    // Listing shows the links as unreachable, and deleting one removes only the link.
    let list = client.get("/api/fs/list?path=").json();
    let link = list["entries"].as_array().unwrap().iter().find(|e| e["name"] == "link.txt").unwrap().clone();
    assert_eq!(link["unreachable"], true);
    let deleted = client.post_json("/api/fs/delete", &json!({ "paths": ["link.txt"] }));
    assert_eq!(deleted.json()["deleted"], 1);
    assert!(outside.path().join("passwd").exists());
}

#[test]
fn workspace_ids_belong_to_their_session() {
    let server = Server::start(Scheme::Http);
    server.write("a.txt", "a");
    let alice = server.session();
    let mut mallory = server.client();
    assert_eq!(mallory.login(common::PASSWORD).status, 200);
    mallory.workspace = alice.workspace.clone();
    let response = mallory.get("/api/fs/read?path=a.txt");
    assert_eq!(response.status, 404);
    assert_eq!(response.json()["error"], "no_workspace");
    // Without any workspace id there is no file access at all.
    mallory.workspace = None;
    assert_eq!(mallory.get("/api/fs/list?path=").status, 404);
}

#[test]
fn text_round_trips_with_crlf_and_bom() {
    let server = Server::start(Scheme::Http);
    server.write("win.txt", b"\xEF\xBB\xBFone\r\ntwo\r\n");
    let client = server.session();
    let read = client.get("/api/fs/read?path=win.txt");
    assert_eq!(read.status, 200);
    assert_eq!(read.text(), "one\ntwo\n");
    assert_eq!(read.header("x-tendril-eol"), Some("crlf"));
    assert_eq!(read.header("x-tendril-bom"), Some("1"));
    let mtime = read.header("x-tendril-mtime").unwrap().to_string();
    let size = read.header("x-tendril-size").unwrap().to_string();

    let write = client.request(
        "PUT",
        "/api/fs/write?path=win.txt",
        &[
            ("X-Tendril-Eol", "crlf"),
            ("X-Tendril-Bom", "1"),
            ("X-Tendril-Expect-Mtime", &mtime),
            ("X-Tendril-Expect-Size", &size),
        ],
        b"one\ntwo\nthree\n",
    );
    assert_eq!(write.status, 200, "{}", write.text());
    assert_eq!(server.read("win.txt"), b"\xEF\xBB\xBFone\r\ntwo\r\nthree\r\n");
    // No temporary file is left in the workspace.
    let names: Vec<_> = std::fs::read_dir(server.workspace.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names.len(), 1, "{names:?}");
}

#[test]
fn saving_over_an_external_change_is_a_conflict() {
    let server = Server::start(Scheme::Http);
    server.write("notes.md", "v1");
    let client = server.session();
    let read = client.get("/api/fs/read?path=notes.md");
    let mtime = read.header("x-tendril-mtime").unwrap().to_string();
    let size = read.header("x-tendril-size").unwrap().to_string();
    // Someone else edits the file.
    server.write("notes.md", "version two from another program");
    let save = client.request(
        "PUT",
        "/api/fs/write?path=notes.md",
        &[("X-Tendril-Expect-Mtime", &mtime), ("X-Tendril-Expect-Size", &size)],
        b"my version",
    );
    assert_eq!(save.status, 409);
    assert_eq!(save.json()["error"], "conflict");
    assert_eq!(save.json()["exists"], true);
    assert_eq!(server.read("notes.md"), b"version two from another program");
    // Overwriting on purpose (no expectation) works.
    assert_eq!(client.request("PUT", "/api/fs/write?path=notes.md", &[], b"my version").status, 200);
    assert_eq!(server.read("notes.md"), b"my version");
}

#[test]
fn editor_limits_binary_files_and_media() {
    let server = Server::start(Scheme::Http);
    server.write("big.log", vec![b'x'; 6 * 1024 * 1024]);
    server.write("image.png", [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    server.write("page.html", "<script>alert(document.cookie)</script>");
    server.write("logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    let client = server.session();

    let big = client.get("/api/fs/read?path=big.log");
    assert_eq!(big.status, 413);
    assert_eq!(big.json()["limit"], 5 * 1024 * 1024);
    assert_eq!(client.get("/api/fs/read?path=image.png").json()["error"], "binary");

    let png = client.get("/api/fs/raw?path=image.png");
    assert_eq!(png.status, 200);
    assert_eq!(png.header("content-type"), Some("image/png"));
    assert!(png.header("content-disposition").unwrap().starts_with("inline"));

    // HTML from the workspace is never served as a page of Tendril's origin.
    let html = client.get("/api/fs/raw?path=page.html");
    assert_eq!(html.header("content-type"), Some("application/octet-stream"));
    assert!(html.header("content-disposition").unwrap().starts_with("attachment"));
    assert!(html.header("content-security-policy").unwrap().starts_with("sandbox"));
    // SVG is an image, but sandboxed if opened directly.
    let svg = client.get("/api/fs/raw?path=logo.svg");
    assert_eq!(svg.header("content-type"), Some("image/svg+xml"));
    assert!(svg.header("content-security-policy").unwrap().starts_with("sandbox"));
}

#[test]
fn media_supports_range_requests() {
    let server = Server::start(Scheme::Http);
    let data: Vec<u8> = (0..=255u8).cycle().take(100_000).collect();
    server.write("clip.webm", &data);
    let client = server.session();
    let part = client.request("GET", "/api/fs/raw?path=clip.webm", &[("Range", "bytes=1000-1999")], b"");
    assert_eq!(part.status, 206);
    assert_eq!(part.header("content-range"), Some("bytes 1000-1999/100000"));
    assert_eq!(part.body, data[1000..2000]);
    let tail = client.request("GET", "/api/fs/raw?path=clip.webm", &[("Range", "bytes=-10")], b"");
    assert_eq!(tail.body, data[99_990..]);
    let bad = client.request("GET", "/api/fs/raw?path=clip.webm", &[("Range", "bytes=200000-")], b"");
    assert_eq!(bad.status, 416);
    let whole = client.get("/api/fs/raw?path=clip.webm&download=1");
    assert_eq!(whole.status, 200);
    assert_eq!(whole.body, data);
    assert!(whole.header("content-disposition").unwrap().starts_with("attachment"));
}

#[test]
fn create_rename_copy_duplicate_delete() {
    let server = Server::start(Scheme::Http);
    let client = server.session();
    assert_eq!(client.post_json("/api/fs/create", &json!({ "path": "src", "dir": true })).status, 200);
    assert_eq!(client.post_json("/api/fs/create", &json!({ "path": "src/main.rs" })).status, 200);
    let again = client.post_json("/api/fs/create", &json!({ "path": "src/main.rs" }));
    assert_eq!(again.status, 409);
    let bad_name = client.post_json("/api/fs/create", &json!({ "path": "src/what?.rs" }));
    assert_eq!(bad_name.status, 400);

    let moved = client.post_json("/api/fs/rename", &json!({ "from": "src/main.rs", "to": "src/lib.rs" }));
    assert_eq!(moved.json()["path"], "src/lib.rs");
    let copied = client.post_json("/api/fs/copy", &json!({ "from": "src", "to": "src2" }));
    assert_eq!(copied.status, 200);
    assert!(server.workspace.path().join("src2/lib.rs").exists());
    let dup = client.post_json("/api/fs/duplicate", &json!({ "path": "src2/lib.rs" }));
    assert_eq!(dup.json()["path"], "src2/lib copy.rs");
    let into_itself = client.post_json("/api/fs/rename", &json!({ "from": "src", "to": "src/inner" }));
    assert_eq!(into_itself.status, 400);

    let deleted = client.post_json("/api/fs/delete", &json!({ "paths": ["src2", "missing.txt", ""] }));
    let body = deleted.json();
    assert_eq!(body["deleted"], 1);
    assert_eq!(body["errors"].as_array().unwrap().len(), 2);
    assert!(!server.workspace.path().join("src2").exists());
    assert!(server.workspace.path().exists(), "the root must survive");

    let listing = client.get("/api/fs/list?path=").json();
    let names: Vec<&str> = listing["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["src"]);
}

#[test]
fn uploads_stream_to_disk_and_respect_overwrite() {
    let server = Server::start(Scheme::Http);
    let client = server.session();
    let payload: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let up = client.request("PUT", "/api/fs/upload?path=data.bin", &[], &payload);
    assert_eq!(up.status, 200, "{}", up.text());
    assert_eq!(up.json()["size"], 300_000);
    assert_eq!(server.read("data.bin"), payload);
    let again = client.request("PUT", "/api/fs/upload?path=data.bin", &[], b"x");
    assert_eq!(again.status, 409);
    let forced = client.request("PUT", "/api/fs/upload?path=data.bin&overwrite=1", &[], b"x");
    assert_eq!(forced.status, 200);
    assert_eq!(server.read("data.bin"), b"x");
    let names: Vec<_> = std::fs::read_dir(server.workspace.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names.len(), 1, "temporary upload files must not remain: {names:?}");
}

#[test]
fn search_finds_files_and_text() {
    let server = Server::start(Scheme::Http);
    server.write("src/main.rs", "fn main() {\n    println!(\"needle\");\n}\n");
    server.write("README.md", "No needles here? One needle.\n");
    server.write("node_modules/dep/index.js", "needle");
    let client = server.session();
    let files = client.get("/api/fs/files").json();
    assert_eq!(files["files"], json!(["README.md", "src/main.rs"]));
    let grep = client.post_json("/api/fs/grep", &json!({ "query": "needle", "whole_word": true })).json();
    assert_eq!(grep["total"], 2, "{grep}");
}

#[test]
fn the_picker_lists_folders_only() {
    let server = Server::start(Scheme::Http);
    server.write("dir/file.txt", "x");
    std::fs::create_dir_all(server.workspace.path().join("other")).unwrap();
    let mut client = server.client();
    client.login(common::PASSWORD);
    let roots = client.get("/api/picker/roots").json();
    assert!(!roots["roots"].as_array().unwrap().is_empty());
    let path = server.workspace.path().to_string_lossy().into_owned();
    let listing = client.get(&format!("/api/picker/list?path={}", enc(&path))).json();
    let names: Vec<&str> = listing["dirs"].as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["dir", "other"]);
    assert_eq!(client.get("/api/picker/list?path=relative").status, 400);
    // Opening a file as a workspace is refused.
    let file = server.workspace.path().join("dir/file.txt").to_string_lossy().into_owned();
    assert_eq!(client.post_json("/api/workspace/open", &json!({ "path": file })).status, 400);
    // Recent folders are remembered across restarts in recent.json.
    let opened = client.post_json("/api/workspace/open", &json!({ "path": path }));
    assert_eq!(opened.status, 200);
    assert!(server.data.path().join(".tendril/recent.json").exists());
}
