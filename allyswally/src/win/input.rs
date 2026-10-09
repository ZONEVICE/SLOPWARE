//! Input injection primitives built on `SendInput`.
//!
//! These are the low-level verbs — move the cursor, press a button, turn the
//! wheel, press/release a key, type a Unicode string. The stateful logic
//! (modifier ordering, releasing stuck keys when a client drops) lives one
//! layer up in [`crate::input`]; this module only knows how to speak to
//! `SendInput`.
//!
//! Keys are driven by **scancode**, not virtual key, because many games read
//! raw scancodes and ignore synthetic virtual keys. Text is injected as
//! `KEYEVENTF_UNICODE` so it is independent of the host keyboard layout.

use super::ffi::*;
use std::mem::size_of;

const INPUT_SIZE: i32 = size_of::<INPUT>() as i32;

fn send(inputs: &[INPUT]) -> bool {
    if inputs.is_empty() {
        return true;
    }
    let sent = unsafe { SendInput(inputs.len() as DWORD, inputs.as_ptr(), INPUT_SIZE) };
    sent as usize == inputs.len()
}

fn mouse_input(flags: DWORD, dx: LONG, dy: LONG, data: DWORD) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        u: INPUT_union {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key_input(vk: WORD, scan: WORD, flags: DWORD) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        u: INPUT_union {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

// ---------------------------------------------------------------------------
// Mouse movement
// ---------------------------------------------------------------------------

/// The bounds of the virtual desktop (all monitors), in pixels.
pub fn virtual_desktop() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

/// Current cursor position in screen pixels.
pub fn cursor_pos() -> (i32, i32) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe {
        GetCursorPos(&mut p);
    }
    (p.x, p.y)
}

/// Move the cursor by `(dx, dy)` pixels in **absolute** mode: read the current
/// position, add the delta, clamp to the virtual desktop and jump there. This
/// is immune to the host's "Enhance pointer precision" setting, so motion is
/// predictable. Multi-monitor aware via the virtual-desktop origin.
pub fn move_absolute(dx: i32, dy: i32) {
    let (x, y) = cursor_pos();
    let (vx, vy, vw, vh) = virtual_desktop();
    let nx = (x + dx).clamp(vx, vx + vw - 1);
    let ny = (y + dy).clamp(vy, vy + vh - 1);
    unsafe {
        SetCursorPos(nx, ny);
    }
}

/// Move the cursor by a raw relative delta (`MOUSEEVENTF_MOVE`). This path is
/// affected by the host pointer-acceleration setting and is offered for games
/// that read raw input.
pub fn move_relative(dx: i32, dy: i32) {
    send(&[mouse_input(MOUSEEVENTF_MOVE, dx, dy, 0)]);
}

// ---------------------------------------------------------------------------
// Mouse buttons
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Button {
    Left,
    Right,
    Middle,
}

impl Button {
    fn down_up(self) -> (DWORD, DWORD) {
        match self {
            Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        }
    }
}

pub fn button_down(b: Button) {
    send(&[mouse_input(b.down_up().0, 0, 0, 0)]);
}

pub fn button_up(b: Button) {
    send(&[mouse_input(b.down_up().1, 0, 0, 0)]);
}

pub fn click(b: Button) {
    let (d, u) = b.down_up();
    send(&[mouse_input(d, 0, 0, 0), mouse_input(u, 0, 0, 0)]);
}

// ---------------------------------------------------------------------------
// Scroll
// ---------------------------------------------------------------------------

/// Vertical wheel. `amount` is in wheel units where 120 is one notch; smaller
/// values give smooth high-resolution scrolling.
pub fn scroll_vertical(amount: i32) {
    send(&[mouse_input(MOUSEEVENTF_WHEEL, 0, 0, amount as DWORD)]);
}

/// Horizontal wheel (two-finger sideways).
pub fn scroll_horizontal(amount: i32) {
    send(&[mouse_input(MOUSEEVENTF_HWHEEL, 0, 0, amount as DWORD)]);
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/// Translate a virtual-key code to its scancode via the active layout.
pub fn vk_to_scan(vk: u16) -> u16 {
    // MAPVK_VK_TO_VSC = 0
    unsafe { MapVirtualKeyW(vk as DWORD, 0) as u16 }
}

/// Press (or release, when `up`) a key by scancode. `extended` sets the
/// extended-key bit required by the arrow cluster, Insert/Delete/Home/End,
/// Page Up/Down, the right Ctrl/Alt and the Windows keys.
pub fn key_scan(scan: u16, extended: bool, up: bool) {
    let mut flags = KEYEVENTF_SCANCODE;
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    send(&[key_input(0, scan, flags)]);
}

/// Press or release a key by virtual-key code, translating to scancode first
/// so games that ignore synthetic virtual keys still see it.
pub fn key_vk(vk: u16, extended: bool, up: bool) {
    let scan = vk_to_scan(vk);
    if scan == 0 {
        // No scancode mapping (e.g. media keys): fall back to the virtual key.
        let mut flags = 0;
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        send(&[key_input(vk, 0, flags)]);
    } else {
        key_scan(scan, extended, up);
    }
}

/// Tap a multimedia / virtual key by its VK code only (volume, play/pause).
/// These have no useful scancode, so they go through the virtual-key path.
pub fn tap_vk(vk: u16, extended: bool) {
    let mut down = 0;
    let mut up = KEYEVENTF_KEYUP;
    if extended {
        down |= KEYEVENTF_EXTENDEDKEY;
        up |= KEYEVENTF_EXTENDEDKEY;
    }
    send(&[key_input(vk, 0, down), key_input(vk, 0, up)]);
}

/// Type a single Unicode scalar value with `KEYEVENTF_UNICODE`, emitting a
/// UTF-16 surrogate pair for astral characters (emoji). Layout-independent.
pub fn type_char(ch: char) {
    let mut buf = [0u16; 2];
    let units = ch.encode_utf16(&mut buf);
    let mut inputs: Vec<INPUT> = Vec::with_capacity(units.len() * 2);
    for &unit in units.iter() {
        inputs.push(key_input(0, unit, KEYEVENTF_UNICODE));
        inputs.push(key_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    send(&inputs);
}

/// Type a whole string, character by character.
pub fn type_text(s: &str) {
    for ch in s.chars() {
        type_char(ch);
    }
}
