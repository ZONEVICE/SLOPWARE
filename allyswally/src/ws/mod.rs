//! WebSocket (RFC 6455) by hand: the handshake and text/binary/ping/pong/close
//! framing. No `tungstenite`, no async.
//!
//! The browser opens one WebSocket per session; the server speaks it on the
//! connection's own thread. Control frames (ping/pong/close) are handled here;
//! data frames are surfaced to the caller as [`Message`].

mod frame;
mod handshake;

pub use frame::{read_message, write_binary, write_close, write_pong, write_text, Message};
pub use handshake::accept_key;
