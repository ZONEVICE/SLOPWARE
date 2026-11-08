//! The terminal WebSocket.
//!
//! `GET /api/term?ws=<id>&cols=<n>&rows=<n>[&path=<rel>]` upgrades to a
//! WebSocket bound to a new shell started in the workspace root, or in the
//! workspace folder `path`. The guard has already checked the session cookie
//! and the `Origin` (cross-site WebSocket hijacking).
//!
//! Frames:
//! - browser -> server, **binary**: keystrokes (UTF-8), written to the PTY;
//!   these are the only frames that count as user activity;
//! - browser -> server, **text**: JSON control, `{"t":"resize","cols":n,"rows":n}`;
//! - server -> browser, **binary**: PTY output;
//! - server -> browser, **text**: `{"t":"hello","shell":"bash"}` first; then
//!   `{"t":"notice","text":"..."}` when `terminal_shell` could not be started
//!   and the default shell was used instead; `{"t":"exit","code":n}` when the
//!   shell exits.
//!
//! Closing the socket kills the shell.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;
use serde_json::json;

use super::super::error::ApiError;
use super::super::guard::Ws;
use super::super::state::AppState;
use super::Routes;
use crate::services::events::Event;
use crate::services::files::jail;
use crate::services::terminals::{Terminal, TerminalError};

/// Registers the route.
pub fn register(mut routes: Routes) -> Routes {
    routes.private = routes.private.route("/api/term", get(open));
    routes
}

#[derive(Deserialize)]
struct TermQuery {
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default = "default_rows")]
    rows: u16,
    #[serde(default)]
    path: String,
}

fn default_cols() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}

#[derive(Deserialize)]
struct ControlMessage {
    t: String,
    #[serde(default)]
    cols: u16,
    #[serde(default)]
    rows: u16,
}

async fn open(
    State(state): State<AppState>,
    ws: Ws,
    Query(q): Query<TermQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let settings = state.settings.get();
    let root = match ws.jail.resolve(&q.path) {
        Ok(dir) if dir.is_dir() => dir,
        Ok(_) => return ApiError::bad_request("not a folder").into_response(),
        Err(err) => return ApiError::from(err).into_response(),
    };
    let cwd = jail::display(&root);
    // Working directory handed to the shell. On Windows the canonical `root`
    // carries the `\\?\` verbatim prefix, which cmd.exe rejects as a UNC path
    // (it then starts in C:\Windows) and PowerShell turns into an ugly
    // `Microsoft.PowerShell.Core\FileSystem::\\?\...` prompt; give the shell the
    // displayed path instead, keeping the verbatim form only when the path is
    // too long for the classic MAX_PATH limit, where the plain form would be an
    // invalid working directory. On Unix `root` is already clean and may hold
    // non-UTF-8 bytes, so it is used unchanged.
    #[cfg(windows)]
    let shell_cwd = if cwd.len() <= 255 { std::path::PathBuf::from(&cwd) } else { root };
    #[cfg(not(windows))]
    let shell_cwd = root;
    let spawned = {
        let state = state.clone();
        let shell = settings.terminal_shell.clone();
        let max = settings.max_terminals as usize;
        tokio::task::spawn_blocking(move || state.terminals.spawn(&shell, &shell_cwd, q.cols, q.rows, max)).await
    };
    let terminal = match spawned {
        Ok(Ok(terminal)) => terminal,
        Ok(Err(TerminalError::Limit(n))) => {
            return ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "terminal_limit",
                format!("At most {n} terminals can be open at once"),
            )
            .into_response();
        }
        Ok(Err(err)) => return ApiError::internal(err.to_string()).into_response(),
        Err(err) => return ApiError::from(err).into_response(),
    };
    if let Some(notice) = &terminal.notice {
        state.publish(Event::SettingsWarning { message: notice.clone() });
    }
    state.publish(Event::TerminalOpened { ip: ws.ip.to_string(), id: terminal.id, shell: terminal.shell.clone(), cwd });
    upgrade.max_message_size(1024 * 1024).on_upgrade(move |socket| bridge(socket, terminal, state))
}

/// Pumps bytes both ways until either side closes.
async fn bridge(mut socket: WebSocket, mut terminal: Terminal, state: AppState) {
    let mut stop = state.shutdown.subscribe();
    let hello = json!({ "t": "hello", "shell": terminal.name }).to_string();
    let _ = socket.send(Message::Text(hello.into())).await;
    if let Some(notice) = &terminal.notice {
        let notice = json!({ "t": "notice", "text": notice }).to_string();
        let _ = socket.send(Message::Text(notice.into())).await;
    }
    let reason = loop {
        tokio::select! {
            output = terminal.output.recv() => match output {
                Some(bytes) => {
                    if socket.send(Message::Binary(bytes.into())).await.is_err() {
                        break "browser disconnected";
                    }
                }
                None => {
                    // Give the waiter thread a moment to record the exit code.
                    for _ in 0..20 {
                        if terminal.exit_code() >= 0 {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                    let message = json!({ "t": "exit", "code": terminal.exit_code() }).to_string();
                    let _ = socket.send(Message::Text(message.into())).await;
                    let _ = socket.send(Message::Close(None)).await;
                    break "shell exited";
                }
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Binary(data))) => {
                    state.activity.touch();
                    terminal.write(data.to_vec());
                }
                Some(Ok(Message::Text(text))) => {
                    if let Ok(control) = serde_json::from_str::<ControlMessage>(&text)
                        && control.t == "resize"
                        && control.cols > 0
                        && control.rows > 0
                    {
                        terminal.resize(control.cols, control.rows);
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break "browser closed the terminal",
                Some(Ok(_)) => {}
            },
            _ = stop.changed() => break "server stopping",
        }
    };
    let id = terminal.id;
    drop(terminal);
    state.publish(Event::TerminalClosed { id, reason: reason.into() });
}
