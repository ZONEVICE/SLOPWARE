//! Login, the per-IP blacklist, sessions, CSRF protection and headers,
//! against a real server over HTTP.

mod common;

use common::{Client, PASSWORD, Server};
use serde_json::json;
use tendril::config::cli::Scheme;

#[test]
fn the_login_page_is_served_until_logged_in() {
    let server = Server::start(Scheme::Http);
    let mut client = server.client();
    let page = client.request("GET", "/", &[("Accept-Encoding", "gzip")], b"");
    assert_eq!(page.status, 200);
    assert_eq!(page.header("content-encoding"), Some("gzip"));
    assert_eq!(page.header("cache-control"), Some("no-store"));
    let login_etag = page.header("etag").unwrap().to_string();

    // Everything else needs a session.
    assert_eq!(client.get("/api/picker/roots").status, 401);
    assert_eq!(client.request("GET", "/assets/app/main.js", &[("Accept-Encoding", "gzip")], b"").status, 401);
    // The login page's own assets are public.
    assert_eq!(client.request("GET", "/assets/public/login.js", &[("Accept-Encoding", "gzip")], b"").status, 200);
    // Assets are only sent compressed.
    assert_eq!(client.get("/assets/public/login.js").status, 406);

    assert_eq!(client.login(PASSWORD).status, 200);
    let app = client.request("GET", "/", &[("Accept-Encoding", "gzip")], b"");
    assert_eq!(app.status, 200);
    assert_ne!(app.header("etag").unwrap(), login_etag, "the editor page should replace the login page");
    assert_eq!(client.request("GET", "/assets/app/main.js", &[("Accept-Encoding", "gzip")], b"").status, 200);
}

#[test]
fn the_session_cookie_is_locked_down() {
    let server = Server::start(Scheme::Http);
    let mut client = server.client();
    let response = client.login(PASSWORD);
    let cookie = response.header("set-cookie").unwrap();
    assert!(cookie.starts_with("tendril="), "{cookie}");
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict") && cookie.contains("Path=/"));
    assert!(!cookie.contains("Secure"), "plain HTTP cannot use Secure cookies");
    // 256-bit secret + 128-bit id, hex.
    let token = client.cookie.as_ref().unwrap().split_once('=').unwrap().1.to_string();
    assert_eq!(token.len(), 96);

    // A forged token does not work.
    let mut forged = server.client();
    forged.cookie = Some(format!("tendril={}", "a".repeat(96)));
    assert_eq!(forged.get("/api/picker/roots").status, 401);

    // Logout invalidates the session.
    assert_eq!(client.post_json("/api/auth/logout", &json!({})).status, 200);
    assert_eq!(client.get("/api/picker/roots").status, 401);
}

#[test]
fn three_wrong_passwords_block_the_ip_for_everything() {
    let server = Server::start(Scheme::Http);
    let mut client = server.client();
    let first = client.login("nope");
    assert_eq!(first.status, 401);
    assert_eq!(first.json()["remaining"], 2);
    assert_eq!(client.login("nope").json()["remaining"], 1);
    let third = client.login("nope");
    assert_eq!(third.status, 403);
    assert_eq!(third.json()["error"], "blocked");
    // Now even the right password is refused, and so is every page.
    assert_eq!(client.login(PASSWORD).status, 403);
    let page = client.get("/");
    assert_eq!(page.status, 403);
    assert!(page.text().contains("blocked"));
    assert_eq!(client.get("/favicon.svg").status, 403);
    assert_eq!(server.state.auth.blocked_ips(), vec!["127.0.0.1".parse::<std::net::IpAddr>().unwrap()]);
    // The block is in the log.
    server.state.logger.flush();
    let logs = std::fs::read_dir(server.data.path().join(".tendril/logs")).unwrap().next().unwrap().unwrap().path();
    let text = std::fs::read_to_string(logs).unwrap();
    assert!(text.contains("\"auth.ip_blocked\""), "{text}");
    assert!(!text.contains("nope"), "passwords must never be logged");
}

#[test]
fn parallel_wrong_passwords_cannot_exceed_three_attempts() {
    let server = Server::start(Scheme::Http);
    let addr = server.addr;
    let threads: Vec<_> = (0..12)
        .map(|_| {
            std::thread::spawn(move || {
                let mut client = Client::new(addr, Scheme::Http);
                client.login("wrong").status
            })
        })
        .collect();
    let statuses: Vec<u16> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(statuses.iter().filter(|s| **s == 401).count(), 2, "{statuses:?}");
    assert_eq!(statuses.iter().filter(|s| **s == 403).count(), 10, "{statuses:?}");
}

#[test]
fn cross_origin_requests_are_refused_before_they_count() {
    let server = Server::start(Scheme::Http);
    let mut evil = server.client();
    evil.origin = Some("http://evil.example".into());
    for _ in 0..5 {
        let response = evil.login("guess");
        assert_eq!(response.status, 403);
        assert_eq!(response.json()["error"], "cross_origin");
    }
    // No Origin at all is refused too for state-changing requests.
    let mut bare = server.client();
    bare.origin = None;
    assert_eq!(bare.login("guess").status, 403);
    // None of that spent the IP's attempts.
    assert!(server.state.auth.blocked_ips().is_empty());
    let mut good = server.client();
    assert_eq!(good.login(PASSWORD).status, 200);

    // A logged-in cookie is useless from another origin.
    good.origin = Some("http://evil.example".into());
    let response = good.post_json("/api/fs/create", &json!({ "path": "pwned.txt" }));
    assert_eq!(response.status, 403);
}

#[test]
fn security_headers_are_present() {
    let server = Server::start(Scheme::Http);
    let client = server.client();
    let response = client.request("GET", "/", &[("Accept-Encoding", "gzip")], b"");
    let csp = response.header("content-security-policy").unwrap();
    assert!(csp.contains("script-src 'self'"), "{csp}");
    assert!(!csp.contains("unsafe-eval") && !csp.contains("script-src 'self' 'unsafe-inline'"), "{csp}");
    assert!(csp.contains("frame-ancestors 'self'"));
    assert!(csp.contains(&format!("ws://127.0.0.1:{}", server.addr.port())));
    assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(response.header("referrer-policy"), Some("no-referrer"));
    assert_eq!(response.header("cross-origin-opener-policy"), Some("same-origin"));
    let api = client.get("/api/picker/roots");
    assert_eq!(api.header("cache-control"), Some("no-store"));
}

#[test]
fn allowed_hosts_defend_against_dns_rebinding() {
    let server = Server::start(Scheme::Http);
    let mut client = server.session();
    let response = client.patch_json("/api/settings", &json!({ "allowed_hosts": ["editor.example"] }));
    assert_eq!(response.status, 200, "{}", response.text());
    // A request for another host name is refused...
    client.host = "attacker.example:6060".into();
    client.origin = Some("http://attacker.example:6060".into());
    assert_eq!(client.get("/api/system/status").status, 421);
    // ...loopback names always work.
    client.host = format!("localhost:{}", server.addr.port());
    client.origin = Some(format!("http://localhost:{}", server.addr.port()));
    assert_eq!(client.get("/api/system/status").status, 200);
}

#[test]
fn unknown_api_paths_are_json_404s() {
    let server = Server::start(Scheme::Http);
    let client = server.session();
    let response = client.get("/api/does/not/exist");
    assert_eq!(response.status, 404);
    assert_eq!(response.json()["error"], "not_found");
    assert_eq!(client.get("/robots.txt").text(), "User-agent: *\nDisallow: /\n");
}
