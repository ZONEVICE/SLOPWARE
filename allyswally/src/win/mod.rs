//! Safe-ish wrappers over the Win32 API.
//!
//! [`ffi`] holds the raw declarations; everything else in this module is the
//! only code allowed to call them. Each submodule owns one slice of the OS
//! surface (console setup, input injection, clipboard, power, system info,
//! network adapters, the CSPRNG, single-instance guard, shell open). Callers
//! above this layer never touch `ffi` directly and never write `unsafe`.

pub mod clipboard;
pub mod console;
pub mod crypto;
pub mod elevation;
pub mod ffi;
pub mod input;
pub mod instance;
pub mod net;
pub mod power;
pub mod shell;
pub mod sysinfo;

/// Encode a Rust string as a NUL-terminated UTF-16 buffer for the `...W`
/// Win32 entry points.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Decode a NUL-terminated UTF-16 buffer (as returned by Win32) back to a
/// Rust string, stopping at the first NUL.
pub fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}
