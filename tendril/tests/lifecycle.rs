//! Process-level behaviour: HTTPS with a fresh certificate, the port walk,
//! settings, the idle timeout (and what counts as activity), and stopping
//! from the Settings tab.

mod common;

use std::time::Duration;

use common::{PASSWORD, Server};
use serde_json::json;
use tendril::config::cli::Scheme;

#[test]
fn https_serves_a_new_certificate_every_start() {
    let server = Server::start(Scheme::Https);
    let mut client = server.client();
    let response = client.login(PASSWORD);
    assert_eq!(response.status, 200);
    let cookie = response.header("set-cookie").unwrap();
    assert!(cookie.starts_with("__Host-tendril="), "{cookie}");
    assert!(cookie.contains("Secure"));
    let cert_dir = server.data.path().join(".tendril/cert");
    let first_pem = std::fs::read_to_string(cert_dir.join("cert.pem")).unwrap();
    assert!(first_pem.contains("BEGIN CERTIFICATE"));
    assert!(std::fs::read_to_string(cert_dir.join("key.pem")).unwrap().contains("PRIVATE KEY"));
    let fingerprint = server.state.info.fingerprint.clone().unwrap();
    assert_eq!(fingerprint.len(), 95);
    let csp = client.get("/api/system/status").header("content-security-policy").unwrap().to_string();
    assert!(csp.contains("wss://"), "{csp}");

    // A second start with the same data directory replaces the certificate.
    let data = server.data.path().join(".tendril");
    drop(client);
    let second = Server::start_with(Scheme::Https, |o| o.data_dir = tendril::config::paths::DataDir::at(&data));
    assert_ne!(second.state.info.fingerprint.clone().unwrap(), fingerprint);
    assert_ne!(std::fs::read_to_string(cert_dir.join("cert.pem")).unwrap(), first_pem);
}

#[test]
fn a_busy_port_moves_to_the_next_one() {
    let first = Server::start(Scheme::Http);
    let busy = first.addr.port();
    let second = Server::start_with(Scheme::Http, |o| o.port = Some(busy));
    assert_ne!(second.addr.port(), busy);
    assert!(second.addr.port() > busy && second.addr.port() < busy.saturating_add(64));
    assert_eq!(second.client().get("/robots.txt").status, 200);
}

#[test]
fn settings_round_trip_and_never_expose_the_password() {
    let server = Server::start(Scheme::Http);
    let client = server.session();
    let view = client.get("/api/settings").json();
    assert_eq!(view["settings"]["idle_timeout_minutes"], 180);
    assert_eq!(view["settings"]["port"], 6060);
    assert!(view["settings"].get("password").is_none());
    assert_eq!(view["meta"]["password_source"], "cli");

    let bad = client.patch_json("/api/settings", &json!({ "idle_timeout_minutes": 0 }));
    assert_eq!(bad.status, 400);
    assert_eq!(bad.json()["error"], "invalid_settings");

    let ok = client.patch_json("/api/settings", &json!({ "idle_timeout_minutes": 5, "editor": { "word_wrap": true } }));
    assert_eq!(ok.status, 200);
    assert_eq!(server.state.activity.timeout(), Duration::from_secs(300));
    let file = std::fs::read_to_string(server.data.path().join(".tendril/settings.json")).unwrap();
    let saved: serde_json::Value = serde_json::from_str(&file).unwrap();
    assert_eq!(saved["idle_timeout_minutes"], 5);
    assert_eq!(saved["editor"]["word_wrap"], true);

    // With --password, a password saved in settings does not replace it.
    let patched = client.patch_json("/api/settings", &json!({ "password": "from-settings" }));
    assert_eq!(patched.json()["settings"]["password_set"], true);
    let mut other = server.client();
    assert_eq!(other.login("from-settings").status, 401);
    assert_eq!(other.login(PASSWORD).status, 200);
}

#[test]
fn a_password_from_settings_applies_immediately_without_cli() {
    let server = Server::start_with(Scheme::Http, |o| o.password = None);
    // No --password and no settings password: a random one was generated.
    assert_eq!(server.state.auth.password_source().as_str(), "random");
    // Log in through the state to set a known password, as the Settings tab would.
    server.state.auth.set_password("known", tendril::services::auth::PasswordSource::Settings);
    let mut client = server.client();
    assert_eq!(client.login("known").status, 200);
    let response = client.patch_json("/api/settings", &json!({ "password": "brand new" }));
    assert_eq!(response.status, 200);
    let mut fresh = server.client();
    assert_eq!(fresh.login("brand new").status, 200);
    // The old session is still valid.
    assert_eq!(client.get("/api/settings").status, 200);
}

#[test]
fn only_user_actions_count_as_activity() {
    let server = Server::start(Scheme::Http);
    let client = server.session();
    server.state.activity.set_timeout(Duration::from_secs(3600));
    std::thread::sleep(Duration::from_millis(1200));
    let before = server.state.activity.idle();
    // Status polls never count, whatever the browser says.
    client.get("/api/system/status");
    // Requests marked quiet do not count either.
    client.request("GET", "/api/fs/list?path=", &[("X-Tendril-Quiet", "1")], b"");
    assert!(server.state.activity.idle() >= before, "quiet requests must not reset the idle timer");
    // A normal request does.
    client.get("/api/fs/list?path=");
    assert!(server.state.activity.idle() < Duration::from_millis(500));
}

#[test]
fn the_idle_timeout_stops_the_process() {
    let mut server = Server::start(Scheme::Http);
    server.state.activity.set_timeout(Duration::from_millis(400));
    let reason = server.wait_stopped(Duration::from_secs(10));
    assert!(reason.starts_with("idle timeout"), "{reason}");
}

#[test]
fn the_idle_timeout_stops_the_process_on_time() {
    // With the production check interval (a minute), the process must still
    // stop right when the timeout expires, not up to a minute later: the
    // browser's countdown reaches zero at that moment and then checks that
    // the server is gone.
    let mut server = Server::start_with(Scheme::Http, |options| options.watchdog_every = Duration::from_secs(60));
    server.state.activity.set_timeout(Duration::from_millis(600));
    let started = std::time::Instant::now();
    let reason = server.wait_stopped(Duration::from_secs(10));
    assert!(reason.starts_with("idle timeout"), "{reason}");
    assert!(started.elapsed() < Duration::from_secs(3), "stopped after {:?}", started.elapsed());
}

#[test]
fn the_settings_tab_can_stop_the_server() {
    let mut server = Server::start(Scheme::Http);
    let client = server.session();
    let response = client.post_json("/api/system/shutdown", &json!({}));
    assert_eq!(response.status, 200);
    let data_dir = server.data.path().join(".tendril/logs");
    let reason = server.wait_stopped(Duration::from_secs(10));
    assert!(reason.contains("Settings tab"), "{reason}");
    let log = std::fs::read_dir(data_dir).unwrap().next().unwrap().unwrap().path();
    let text = std::fs::read_to_string(log).unwrap();
    assert!(text.contains("\"server.stopping\""), "{text}");
}

#[test]
fn system_info_reports_the_process() {
    let server = Server::start(Scheme::Http);
    let client = server.session();
    let info = client.get("/api/system/info").json();
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(info["scheme"], "http");
    assert_eq!(info["sessions"], 1);
    assert!(info["blocked_ips"].as_array().unwrap().is_empty());
}
