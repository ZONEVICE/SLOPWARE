//! Host clipboard access (`CF_UNICODETEXT`).
//!
//! MASKED's clipboard feature writes text here and then sends Ctrl+V. Reading
//! the previous contents first lets the caller optionally restore them.

use super::ffi::*;
use std::ffi::c_void;

/// Replace the host clipboard with `text`. Returns false if the clipboard
/// could not be opened (another process holds it); the caller logs and moves
/// on rather than retrying forever.
pub fn set_text(text: &str) -> bool {
    let mut utf16: Vec<u16> = text.encode_utf16().collect();
    utf16.push(0);
    let bytes = utf16.len() * 2;
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if h.is_null() {
            return false;
        }
        let dst = GlobalLock(h);
        if dst.is_null() {
            GlobalFree(h);
            return false;
        }
        std::ptr::copy_nonoverlapping(utf16.as_ptr() as *const c_void, dst, bytes);
        GlobalUnlock(h);
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            GlobalFree(h);
            return false;
        }
        EmptyClipboard();
        // Ownership of `h` transfers to the clipboard on success; do not free.
        let ok = !SetClipboardData(CF_UNICODETEXT, h).is_null();
        CloseClipboard();
        if !ok {
            GlobalFree(h);
        }
        ok
    }
}

/// Read the host clipboard as text, if it currently holds Unicode text.
pub fn get_text() -> Option<String> {
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT) == 0 {
            return None;
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }
        let h = GetClipboardData(CF_UNICODETEXT);
        if h.is_null() {
            CloseClipboard();
            return None;
        }
        let ptr = GlobalLock(h) as *const u16;
        if ptr.is_null() {
            CloseClipboard();
            return None;
        }
        let mut len = 0usize;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(ptr, len);
        let s = String::from_utf16_lossy(slice);
        GlobalUnlock(h);
        CloseClipboard();
        Some(s)
    }
}
