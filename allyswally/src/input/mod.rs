//! Per-connection input state and the high-level input verbs.
//!
//! Each WebSocket connection owns one [`InputSession`]. It tracks which keys
//! and mouse buttons that client is holding, so that if the socket drops in the
//! middle of a combo or a click-drag the server can release everything and no
//! key is ever left stuck down on the host. Combos press modifiers in order and
//! release them in reverse, per RFC-of-good-manners for `SendInput`.

pub mod keymap;

pub use keymap::{resolve, Key};

use crate::win::input::{self, Button};

/// Parse a button name from the wire (`left`/`right`/`middle`).
pub fn button_from_str(name: &str) -> Option<Button> {
    match name.to_ascii_lowercase().as_str() {
        "left" | "l" => Some(Button::Left),
        "right" | "r" => Some(Button::Right),
        "middle" | "m" => Some(Button::Middle),
        _ => None,
    }
}

pub struct InputSession {
    keys_down: Vec<Key>,
    buttons_down: Vec<Button>,
}

impl InputSession {
    pub fn new() -> InputSession {
        InputSession {
            keys_down: Vec::new(),
            buttons_down: Vec::new(),
        }
    }

    // --- Mouse ---------------------------------------------------------------

    /// Move the cursor by a delta. `relative` uses raw `MOUSEEVENTF_MOVE` (for
    /// games); the default absolute mode is predictable and multi-monitor safe.
    pub fn move_mouse(&self, dx: i32, dy: i32, relative: bool) {
        if relative {
            input::move_relative(dx, dy);
        } else {
            input::move_absolute(dx, dy);
        }
    }

    pub fn scroll_v(&self, amount: i32) {
        input::scroll_vertical(amount);
    }

    pub fn scroll_h(&self, amount: i32) {
        input::scroll_horizontal(amount);
    }

    pub fn click(&self, b: Button) {
        input::click(b);
    }

    pub fn button_down(&mut self, b: Button) {
        if !self.buttons_down.contains(&b) {
            self.buttons_down.push(b);
        }
        input::button_down(b);
    }

    pub fn button_up(&mut self, b: Button) {
        self.buttons_down.retain(|&x| x != b);
        input::button_up(b);
    }

    // --- Keyboard ------------------------------------------------------------

    /// Press and hold a key, remembering it for cleanup.
    pub fn key_down(&mut self, key: Key) {
        if !self.keys_down.contains(&key) {
            self.keys_down.push(key);
        }
        input::key_vk(key.vk, key.extended, false);
    }

    /// Release a held key.
    pub fn key_up(&mut self, key: Key) {
        self.keys_down.retain(|&k| k != key);
        input::key_vk(key.vk, key.extended, true);
    }

    /// Momentary tap (down then up), not tracked — for a single keypress from
    /// the virtual keyboard where no hold is involved.
    pub fn tap(&self, key: Key) {
        input::key_vk(key.vk, key.extended, false);
        input::key_vk(key.vk, key.extended, true);
    }

    /// Tap a multimedia key by VK code (volume, play/pause).
    pub fn media(&self, key: Key) {
        input::tap_vk(key.vk, key.extended);
    }

    /// Execute a combo given as symbolic names. Modifiers are pressed first (in
    /// listed order), then the remaining keys; all are released in reverse.
    /// Returns false if any name is unknown (nothing is pressed in that case).
    pub fn combo(&self, names: &[String]) -> bool {
        let mut resolved = Vec::with_capacity(names.len());
        for name in names {
            match resolve(name) {
                Some(key) => resolved.push(key),
                None => return false,
            }
        }
        // Stable partition: modifiers keep their relative order, then the rest.
        let mut order: Vec<Key> = resolved.iter().copied().filter(|k| keymap::is_modifier(*k)).collect();
        order.extend(resolved.iter().copied().filter(|k| !keymap::is_modifier(*k)));

        for key in &order {
            input::key_vk(key.vk, key.extended, false);
        }
        for key in order.iter().rev() {
            input::key_vk(key.vk, key.extended, true);
        }
        true
    }

    /// Type a Unicode string (layout-independent). Not tracked.
    pub fn type_text(&self, text: &str) {
        input::type_text(text);
    }

    // --- Cleanup -------------------------------------------------------------

    /// Release everything this session is holding. Called when the connection
    /// closes so no key or button is left stuck on the host.
    pub fn release_all(&mut self) {
        for key in self.keys_down.drain(..).rev().collect::<Vec<_>>() {
            input::key_vk(key.vk, key.extended, true);
        }
        for b in self.buttons_down.drain(..).rev().collect::<Vec<_>>() {
            input::button_up(b);
        }
    }

    /// Count of currently held keys (used in tests and diagnostics).
    pub fn held_keys(&self) -> usize {
        self.keys_down.len()
    }
}

impl Default for InputSession {
    fn default() -> Self {
        InputSession::new()
    }
}

impl Drop for InputSession {
    fn drop(&mut self) {
        // Belt and braces: if a session is dropped without an explicit
        // release_all (e.g. a panic in the handler), still let go of keys.
        self.release_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn button_parsing() {
        assert_eq!(button_from_str("left"), Some(Button::Left));
        assert_eq!(button_from_str("RIGHT"), Some(Button::Right));
        assert_eq!(button_from_str("m"), Some(Button::Middle));
        assert_eq!(button_from_str("x"), None);
    }

    #[test]
    fn combo_rejects_unknown_name() {
        let s = InputSession::new();
        // Does not panic and reports failure; nothing is actually injected
        // because "bogus" fails to resolve before any key is pressed.
        assert!(!s.combo(&["ctrl".into(), "bogus".into()]));
    }
}
