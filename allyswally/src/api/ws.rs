//! The WebSocket control channel: the low-latency path for mouse, keyboard,
//! shortcut execution and the heartbeat.
//!
//! Mouse movement is the hot path and arrives as compact **binary** frames
//! (one type byte + little-endian `i16` deltas) coalesced by the client once
//! per animation frame — never one frame per `pointermove`. Everything else is
//! small JSON. Auth is handled by the caller (server.rs); by the time these
//! functions run the connection is authenticated.
//!
//! Adding a command is one match arm in [`handle_text`].

use super::run;
use crate::input::{keymap, button_from_str, InputSession};
use crate::json::{Obj, Value};
use crate::state::AppState;
use std::sync::Arc;

/// Binary frame type bytes.
const BIN_MOVE_ABS: u8 = 1;
const BIN_MOVE_REL: u8 = 2;
const BIN_SCROLL: u8 = 3;

/// Handle a binary control frame (mouse move / scroll). Silently ignores a
/// malformed frame rather than erroring the connection.
pub fn handle_binary(session: &mut InputSession, data: &[u8]) {
    if data.is_empty() {
        return;
    }
    match data[0] {
        BIN_MOVE_ABS | BIN_MOVE_REL if data.len() >= 5 => {
            let dx = i16::from_le_bytes([data[1], data[2]]) as i32;
            let dy = i16::from_le_bytes([data[3], data[4]]) as i32;
            session.move_mouse(dx, dy, data[0] == BIN_MOVE_REL);
        }
        BIN_SCROLL if data.len() >= 5 => {
            let v = i16::from_le_bytes([data[1], data[2]]) as i32;
            let h = i16::from_le_bytes([data[3], data[4]]) as i32;
            if v != 0 {
                session.scroll_v(v);
            }
            if h != 0 {
                session.scroll_h(h);
            }
        }
        _ => {}
    }
}

/// Handle a JSON control message, returning an optional reply to send back.
pub fn handle_text(state: &Arc<AppState>, session: &mut InputSession, value: &Value) -> Option<Value> {
    let kind = value.get_str("type")?;
    match kind {
        "ping" => {
            // Echo the client timestamp so it can compute round-trip latency.
            let t = value.get("t").cloned().unwrap_or(Value::Null);
            Some(Obj::new().str("type", "pong").set("t", t).build())
        }
        "mouseMove" => {
            let dx = value.get_i64("dx").unwrap_or(0) as i32;
            let dy = value.get_i64("dy").unwrap_or(0) as i32;
            let relative = value.get_bool("relative").unwrap_or(false);
            session.move_mouse(dx, dy, relative);
            None
        }
        "scroll" => {
            let dx = value.get_i64("dx").unwrap_or(0) as i32;
            let dy = value.get_i64("dy").unwrap_or(0) as i32;
            if dy != 0 {
                session.scroll_v(dy);
            }
            if dx != 0 {
                session.scroll_h(dx);
            }
            None
        }
        "click" => {
            if let Some(button) = value.get_str("button").and_then(button_from_str) {
                if value.get_bool("double") == Some(true) {
                    session.click(button);
                    session.click(button);
                } else {
                    session.click(button);
                }
            }
            None
        }
        "down" => {
            if let Some(button) = value.get_str("button").and_then(button_from_str) {
                session.button_down(button);
            }
            None
        }
        "up" => {
            if let Some(button) = value.get_str("button").and_then(button_from_str) {
                session.button_up(button);
            }
            None
        }
        "key" => {
            let name = value.get_str("name").unwrap_or("");
            let action = value.get_str("action").unwrap_or("tap");
            if let Some(key) = keymap::resolve(name) {
                match action {
                    "down" => session.key_down(key),
                    "up" => session.key_up(key),
                    _ => session.tap(key),
                }
            }
            None
        }
        "media" => {
            if let Some(key) = value.get_str("name").and_then(keymap::resolve) {
                session.media(key);
            }
            None
        }
        "combo" => {
            let keys: Vec<String> = value
                .get("keys")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            session.combo(&keys);
            None
        }
        "text" => {
            // Privacy: log only a count, never the content.
            let text = value.get_str("text").unwrap_or("");
            if !text.is_empty() {
                session.type_text(text);
                state.logger.info(
                    "input.text",
                    vec![("chars".into(), Value::Num(text.chars().count() as f64))],
                );
            }
            None
        }
        "run" => {
            // Execute a MASKED item from the shortcut band over the socket.
            let category = value.get_str("category").unwrap_or("");
            let id = value.get_str("id").unwrap_or("");
            let result = run::run_item(state, category, id);
            Some(Obj::new().str("type", "runResult").set("result", result).build())
        }
        _ => None,
    }
}
