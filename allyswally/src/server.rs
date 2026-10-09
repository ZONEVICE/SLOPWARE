//! The TCP accept loop and per-connection handling.
//!
//! One thread per connection (1–3 clients are expected), no async. Each
//! connection is wrapped in `catch_unwind`, so a panic in one client's thread
//! is logged as a bug and never takes the server down. An HTTP keep-alive
//! connection serves many requests; a `/ws` upgrade hands the socket to the
//! WebSocket loop for the rest of its life.

use crate::api::ws as wsapi;
use crate::api::{http as httpapi, ClientInfo};
use crate::events::Outgoing;
use crate::http::read_request;
use crate::input::InputSession;
use crate::json::{self, Obj};
use crate::state::AppState;
use crate::ws;
use std::io::{BufReader, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::panic::AssertUnwindSafe;
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Idle read timeout on a WebSocket: if no frame (including the client's own
/// heartbeat ping, sent every few seconds) arrives within this window, the
/// connection is considered dead and reaped.
const WS_READ_TIMEOUT: Duration = Duration::from_secs(35);

/// Run the accept loop forever.
pub fn run(state: Arc<AppState>, listener: TcpListener) {
    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let st = state.clone();
                thread::spawn(move || {
                    let peer = stream
                        .peer_addr()
                        .map(|a| a.ip())
                        .unwrap_or(IpAddr::from([0, 0, 0, 0]));
                    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                        handle_connection(st.clone(), stream, peer);
                    }));
                    if result.is_err() {
                        // A client thread panicked; record it as a bug and move
                        // on. The server keeps running.
                        st.logger.error(
                            "panic.connection",
                            vec![("ip".into(), json::Value::Str(peer.to_string()))],
                        );
                    }
                });
            }
            Err(e) => {
                state.logger.warn(
                    "accept.error",
                    vec![("error".into(), json::Value::Str(e.to_string()))],
                );
            }
        }
    }
}

fn handle_connection(state: Arc<AppState>, stream: TcpStream, peer: IpAddr) {
    let _ = stream.set_nodelay(true); // disable Nagle: snappy over Bluetooth PAN
    let read_clone = match stream.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut reader = BufReader::new(read_clone);
    let mut write_stream = stream;

    loop {
        let req = match read_request(&mut reader) {
            Ok(Some(r)) => r,
            Ok(None) => return,  // peer closed cleanly
            Err(_) => return,    // malformed or broken connection
        };

        if req.path == "/ws" && req.is_websocket_upgrade() {
            serve_websocket(state, reader, write_stream, &req, peer);
            return; // the socket now belongs to the WebSocket loop
        }

        let client = ClientInfo {
            ip: peer,
            token: req.header("x-token").map(|s| s.to_string()),
            user_agent: req.header("user-agent").unwrap_or("").to_string(),
        };
        let response = httpapi::handle(&state, &req, &client);
        if response.write_to(&mut write_stream).is_err() {
            return;
        }
    }
}

/// Complete the WebSocket handshake and run the read loop until the socket
/// closes. `write_stream` becomes the writer thread's; `reader` stays here.
fn serve_websocket(
    state: Arc<AppState>,
    mut reader: BufReader<TcpStream>,
    mut write_stream: TcpStream,
    req: &crate::http::Request,
    peer: IpAddr,
) {
    let key = match req.header("sec-websocket-key") {
        Some(k) => k,
        None => return,
    };
    let accept = ws::accept_key(key);
    let handshake = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    if write_stream.write_all(handshake.as_bytes()).is_err() {
        return;
    }
    let _ = write_stream.flush();

    // All socket writes go through one writer thread fed by this channel.
    let (tx, rx) = channel::<Outgoing>();
    let writer = thread::spawn(move || {
        for msg in rx {
            let result = match msg {
                Outgoing::Text(t) => ws::write_text(&mut write_stream, &t),
                Outgoing::Binary(b) => ws::write_binary(&mut write_stream, &b),
                Outgoing::Pong(p) => ws::write_pong(&mut write_stream, &p),
                Outgoing::Close => {
                    let _ = ws::write_close(&mut write_stream);
                    break;
                }
            };
            if result.is_err() {
                break;
            }
        }
    });

    // Authenticate (first message must be {type:"auth", token}) unless the
    // debug no-auth flag is set.
    let _ = reader.get_ref().set_read_timeout(Some(WS_READ_TIMEOUT));
    if !authenticate(&state, &mut reader, &tx) {
        let _ = tx.send(Outgoing::Close);
        drop(tx);
        let _ = writer.join();
        return;
    }

    // Register with the hub so broadcasts (band reloads, kicks) reach us.
    let client_id = state.hub.register(tx.clone());
    state.logger.info(
        "ws.connect",
        vec![
            ("ip".into(), json::Value::Str(peer.to_string())),
            ("clients".into(), json::Value::Num(state.hub.client_count() as f64)),
        ],
    );

    let mut session = InputSession::new();
    let outcome = read_loop(&state, &mut reader, &tx, &mut session);

    // Cleanup: release any keys/buttons this client held, deregister, close.
    session.release_all();
    state.hub.unregister(client_id);
    let _ = tx.send(Outgoing::Close);
    drop(tx);
    let _ = writer.join();

    state.logger.info(
        "ws.disconnect",
        vec![
            ("ip".into(), json::Value::Str(peer.to_string())),
            ("reason".into(), json::Value::Str(outcome.to_string())),
            ("clients".into(), json::Value::Num(state.hub.client_count() as f64)),
        ],
    );
}

/// Read the auth handshake. Returns true when the client is authenticated.
fn authenticate(
    state: &Arc<AppState>,
    reader: &mut BufReader<TcpStream>,
    tx: &Sender<Outgoing>,
) -> bool {
    if state.dev_no_auth {
        let _ = tx.send(Outgoing::Text(
            Obj::new().str("type", "authOk").boolean("devNoAuth", true).build().to_string(),
        ));
        return true;
    }
    match ws::read_message(reader) {
        Ok(Some(ws::Message::Text(text))) => {
            let value = match json::parse(&text) {
                Ok(v) => v,
                Err(_) => return false,
            };
            if value.get_str("type") == Some("auth") {
                let token = value.get_str("token").unwrap_or("");
                if state.auth.check_token(token) {
                    let _ = tx.send(Outgoing::Text(
                        Obj::new().str("type", "authOk").build().to_string(),
                    ));
                    return true;
                }
            }
            let _ = tx.send(Outgoing::Text(
                Obj::new().str("type", "authFail").build().to_string(),
            ));
            false
        }
        _ => false,
    }
}

/// The main WebSocket read loop. Returns a short reason string for the log.
fn read_loop(
    state: &Arc<AppState>,
    reader: &mut BufReader<TcpStream>,
    tx: &Sender<Outgoing>,
    session: &mut InputSession,
) -> &'static str {
    loop {
        match ws::read_message(reader) {
            Ok(Some(ws::Message::Text(text))) => {
                if let Ok(value) = json::parse(&text) {
                    if let Some(reply) = wsapi::handle_text(state, session, &value) {
                        if tx.send(Outgoing::Text(reply.to_string())).is_err() {
                            return "writer gone";
                        }
                    }
                }
            }
            Ok(Some(ws::Message::Binary(data))) => {
                wsapi::handle_binary(session, &data);
            }
            Ok(Some(ws::Message::Ping(payload))) => {
                if tx.send(Outgoing::Pong(payload)).is_err() {
                    return "writer gone";
                }
            }
            Ok(Some(ws::Message::Pong(_))) => {}
            Ok(Some(ws::Message::Close)) => return "client close",
            Ok(None) => return "eof",
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                return "heartbeat timeout";
            }
            Err(_) => return "read error",
        }
    }
}
