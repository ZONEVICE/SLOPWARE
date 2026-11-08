//! The terminal WebSocket: a real shell in a pseudo-terminal, started in the
//! workspace, killed when the socket closes; and its protections.
//!
//! The shell differs per platform: `/bin/sh` on Unix, `cmd.exe` on Windows
//! (set through `terminal_shell` for determinism; PowerShell's start-up is
//! slow and noisy). On Windows the test client answers ConPTY's cursor-position
//! request (ESC[6n) so the shell is not left waiting.

mod common;

use std::net::TcpStream;
use std::time::{Duration, Instant};

use common::{Client, Server};
use tendril::config::cli::Scheme;
use tungstenite::handshake::client::generate_key;
use tungstenite::http::Request;
use tungstenite::{Message, WebSocket};

fn connect(client: &Client, query: &str, origin: Option<&str>) -> Result<WebSocket<TcpStream>, tungstenite::Error> {
    let stream = TcpStream::connect(client.addr).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut request = Request::builder()
        .uri(format!("ws://{}/api/term?{query}", client.host))
        .header("Host", &client.host)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key());
    if let Some(origin) = origin {
        request = request.header("Origin", origin);
    }
    if let Some(cookie) = &client.cookie {
        request = request.header("Cookie", cookie);
    }
    let result = tungstenite::client(request.body(()).unwrap(), stream).map(|(ws, _)| ws);
    if let Ok(ws) = &result {
        // Short reads from here on, so the tests can poll.
        ws.get_ref().set_read_timeout(Some(Duration::from_millis(200))).unwrap();
    }
    result.map_err(|e| match e {
        tungstenite::HandshakeError::Failure(err) => err,
        tungstenite::HandshakeError::Interrupted(_) => tungstenite::Error::ConnectionClosed,
    })
}

/// Reads until `needle` appears in the output (or the time runs out). Answers
/// ConPTY's cursor-position request (ESC[6n) so the shell proceeds; harmless on
/// Unix, which never sends it.
fn read_until(ws: &mut WebSocket<TcpStream>, needle: &str, timeout: Duration) -> (String, Vec<String>) {
    let deadline = Instant::now() + timeout;
    let mut output = Vec::new();
    let mut texts = Vec::new();
    while Instant::now() < deadline {
        match ws.read() {
            Ok(Message::Binary(bytes)) => {
                if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                    let _ = ws.send(Message::Binary(b"\x1b[1;1R".to_vec().into()));
                }
                output.extend_from_slice(&bytes);
            }
            Ok(Message::Text(text)) => texts.push(text.to_string()),
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
        if String::from_utf8_lossy(&output).contains(needle) || texts.iter().any(|t| t.contains(needle)) {
            break;
        }
    }
    (String::from_utf8_lossy(&output).into_owned(), texts)
}

#[cfg(unix)]
#[test]
fn runs_a_shell_in_the_workspace_and_reports_exit() {
    let server = Server::start_with(Scheme::Http, |_| {});
    server.write("marker-file.txt", "x");
    let client = server.session();
    let patch = client.patch_json("/api/settings", &serde_json::json!({ "terminal_shell": "/bin/sh" }));
    assert_eq!(patch.status, 200);
    let ws_id = client.workspace.clone().unwrap();
    let origin = client.origin.clone().unwrap();
    let mut ws = connect(&client, &format!("ws={ws_id}&cols=100&rows=30"), Some(&origin)).expect("upgrade");
    let (_, hello) = read_until(&mut ws, "hello", Duration::from_secs(5));
    assert!(hello.iter().any(|t| t.contains("\"shell\":\"sh\"")), "{hello:?}");

    server.state.activity.set_timeout(Duration::from_secs(3600));
    std::thread::sleep(Duration::from_millis(600));
    let idle_before = server.state.activity.idle();
    ws.send(Message::Binary(b"ls; echo DONE-$((6*7))\n".to_vec().into())).unwrap();
    let (output, _) = read_until(&mut ws, "DONE-42", Duration::from_secs(5));
    assert!(output.contains("marker-file.txt"), "the shell should start in the workspace: {output}");
    assert!(output.contains("DONE-42"), "{output}");
    // Typing in the terminal is user activity.
    assert!(server.state.activity.idle() < idle_before);

    ws.send(Message::Text(r#"{"t":"resize","cols":120,"rows":40}"#.into())).unwrap();
    ws.send(Message::Binary(b"exit 7\n".to_vec().into())).unwrap();
    let (_, texts) = read_until(&mut ws, "\"exit\"", Duration::from_secs(5));
    assert!(texts.iter().any(|t| t.contains("\"code\":7")), "{texts:?}");
}

#[cfg(windows)]
#[test]
fn runs_a_shell_in_the_workspace_and_reports_exit() {
    let server = Server::start_with(Scheme::Http, |_| {});
    server.write("marker-file.txt", "x");
    let client = server.session();
    let patch = client.patch_json("/api/settings", &serde_json::json!({ "terminal_shell": "cmd.exe" }));
    assert_eq!(patch.status, 200);
    let ws_id = client.workspace.clone().unwrap();
    let origin = client.origin.clone().unwrap();
    let mut ws = connect(&client, &format!("ws={ws_id}&cols=100&rows=30"), Some(&origin)).expect("upgrade");
    let (_, hello) = read_until(&mut ws, "hello", Duration::from_secs(5));
    assert!(hello.iter().any(|t| t.contains("\"shell\":\"cmd\"")), "{hello:?}");

    server.state.activity.set_timeout(Duration::from_secs(3600));
    std::thread::sleep(Duration::from_millis(600));
    let idle_before = server.state.activity.idle();
    // `dir` must list the workspace: cmd.exe would start in C:\Windows if the
    // working directory still carried the `\\?\` verbatim prefix (see S0). The
    // marker file name does not appear in the echoed command line, so it only
    // matches the directory listing itself.
    ws.send(Message::Binary(b"dir & echo DONE-42\r\n".to_vec().into())).unwrap();
    let (output, _) = read_until(&mut ws, "marker-file.txt", Duration::from_secs(10));
    assert!(output.contains("marker-file.txt"), "the shell should start in the workspace: {output}");
    // Typing in the terminal is user activity.
    assert!(server.state.activity.idle() < idle_before);

    ws.send(Message::Text(r#"{"t":"resize","cols":120,"rows":40}"#.into())).unwrap();
    ws.send(Message::Binary(b"exit 7\r\n".to_vec().into())).unwrap();
    let (_, texts) = read_until(&mut ws, "\"exit\"", Duration::from_secs(10));
    assert!(texts.iter().any(|t| t.contains("\"code\":7")), "{texts:?}");
}

#[test]
fn closing_the_socket_kills_the_shell() {
    let server = Server::start(Scheme::Http);
    let client = server.session();
    // cmd.exe starts faster and more quietly than PowerShell on Windows.
    #[cfg(windows)]
    client.patch_json("/api/settings", &serde_json::json!({ "terminal_shell": "cmd.exe" }));
    let ws_id = client.workspace.clone().unwrap();
    let origin = client.origin.clone().unwrap();
    let mut ws = connect(&client, &format!("ws={ws_id}"), Some(&origin)).expect("upgrade");
    read_until(&mut ws, "hello", Duration::from_secs(5));
    assert_eq!(server.state.terminals.count(), 1);
    drop(ws);
    let deadline = Instant::now() + Duration::from_secs(5);
    while server.state.terminals.count() > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(server.state.terminals.count(), 0);
}

#[test]
fn terminals_need_a_session_the_right_origin_and_a_slot() {
    let server = Server::start(Scheme::Http);
    let client = server.session();
    #[cfg(windows)]
    client.patch_json("/api/settings", &serde_json::json!({ "terminal_shell": "cmd.exe" }));
    let ws_id = client.workspace.clone().unwrap();
    let origin = client.origin.clone().unwrap();

    // Cross-site WebSocket hijacking: a foreign Origin is refused.
    assert!(connect(&client, &format!("ws={ws_id}"), Some("http://evil.example")).is_err());
    assert!(connect(&client, &format!("ws={ws_id}"), None).is_err());
    // No session, no terminal.
    let anonymous = server.client();
    assert!(connect(&anonymous, &format!("ws={ws_id}"), Some(&origin)).is_err());
    assert_eq!(server.state.terminals.count(), 0);

    // The cap.
    client.patch_json("/api/settings", &serde_json::json!({ "max_terminals": 1 }));
    let mut first = connect(&client, &format!("ws={ws_id}"), Some(&origin)).expect("first terminal");
    read_until(&mut first, "hello", Duration::from_secs(5));
    assert!(connect(&client, &format!("ws={ws_id}"), Some(&origin)).is_err(), "the second terminal must be refused");
}
