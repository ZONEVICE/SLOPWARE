//! Map the symbolic key names the front end sends to Win32 virtual-key codes.
//!
//! The browser cannot send scancodes, so it sends names (`"ctrl"`, `"f4"`,
//! `"enter"`, `"a"`). This table resolves each to a VK code and whether it is
//! an *extended* key — the arrow cluster, the navigation block, the right-hand
//! Ctrl/Alt and the Windows keys all need the extended-key bit so the host
//! distinguishes, say, the arrow Up from numpad 8.

/// A resolved key: a virtual-key code and whether it needs the extended-key bit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key {
    pub vk: u16,
    pub extended: bool,
}

const fn k(vk: u16) -> Key {
    Key { vk, extended: false }
}
const fn ext(vk: u16) -> Key {
    Key { vk, extended: true }
}

// Virtual-key codes we reference by name (subset of WinUser.h).
pub const VK_BACK: u16 = 0x08;
pub const VK_TAB: u16 = 0x09;
pub const VK_RETURN: u16 = 0x0D;
pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12; // Alt
pub const VK_PAUSE: u16 = 0x13;
pub const VK_CAPITAL: u16 = 0x14;
pub const VK_ESCAPE: u16 = 0x1B;
pub const VK_SPACE: u16 = 0x20;
pub const VK_PRIOR: u16 = 0x21; // Page Up
pub const VK_NEXT: u16 = 0x22; // Page Down
pub const VK_END: u16 = 0x23;
pub const VK_HOME: u16 = 0x24;
pub const VK_LEFT: u16 = 0x25;
pub const VK_UP: u16 = 0x26;
pub const VK_RIGHT: u16 = 0x27;
pub const VK_DOWN: u16 = 0x28;
pub const VK_SNAPSHOT: u16 = 0x2C; // Print Screen
pub const VK_INSERT: u16 = 0x2D;
pub const VK_DELETE: u16 = 0x2E;
pub const VK_LWIN: u16 = 0x5B;
pub const VK_RWIN: u16 = 0x5C;
pub const VK_APPS: u16 = 0x5D; // Menu / context
pub const VK_LCONTROL: u16 = 0xA2;
pub const VK_RCONTROL: u16 = 0xA3;
pub const VK_LMENU: u16 = 0xA4;
pub const VK_RMENU: u16 = 0xA5;
pub const VK_LSHIFT: u16 = 0xA0;
pub const VK_RSHIFT: u16 = 0xA1;

// Multimedia keys.
pub const VK_VOLUME_MUTE: u16 = 0xAD;
pub const VK_VOLUME_DOWN: u16 = 0xAE;
pub const VK_VOLUME_UP: u16 = 0xAF;
pub const VK_MEDIA_NEXT_TRACK: u16 = 0xB0;
pub const VK_MEDIA_PREV_TRACK: u16 = 0xB1;
pub const VK_MEDIA_STOP: u16 = 0xB2;
pub const VK_MEDIA_PLAY_PAUSE: u16 = 0xB3;

/// Resolve a symbolic name (case-insensitive) to a key. Returns `None` for an
/// unknown name so the caller can log and ignore it rather than press garbage.
pub fn resolve(name: &str) -> Option<Key> {
    let n = name.trim().to_ascii_lowercase();

    // Single letters and digits map to their ASCII-upper VK code directly.
    if n.len() == 1 {
        let c = n.as_bytes()[0];
        if c.is_ascii_alphabetic() {
            return Some(k(c.to_ascii_uppercase() as u16));
        }
        if c.is_ascii_digit() {
            return Some(k(c as u16));
        }
    }

    // Function keys F1..F24 → VK_F1 (0x70) onward.
    if let Some(num) = n.strip_prefix('f') {
        if let Ok(f) = num.parse::<u16>() {
            if (1..=24).contains(&f) {
                return Some(k(0x70 + (f - 1)));
            }
        }
    }

    Some(match n.as_str() {
        "ctrl" | "control" | "lctrl" => k(VK_LCONTROL),
        "rctrl" => ext(VK_RCONTROL),
        "alt" | "lalt" => k(VK_LMENU),
        "ralt" | "altgr" => ext(VK_RMENU),
        "shift" | "lshift" => k(VK_LSHIFT),
        "rshift" => k(VK_RSHIFT),
        "win" | "lwin" | "super" | "meta" | "cmd" => ext(VK_LWIN),
        "rwin" => ext(VK_RWIN),
        "menu" | "apps" | "context" => ext(VK_APPS),
        "enter" | "return" => k(VK_RETURN),
        "esc" | "escape" => k(VK_ESCAPE),
        "tab" => k(VK_TAB),
        "space" | "spacebar" => k(VK_SPACE),
        "backspace" | "back" => k(VK_BACK),
        "delete" | "del" => ext(VK_DELETE),
        "insert" | "ins" => ext(VK_INSERT),
        "home" => ext(VK_HOME),
        "end" => ext(VK_END),
        "pageup" | "pgup" | "prior" => ext(VK_PRIOR),
        "pagedown" | "pgdn" | "next" => ext(VK_NEXT),
        "up" | "arrowup" => ext(VK_UP),
        "down" | "arrowdown" => ext(VK_DOWN),
        "left" | "arrowleft" => ext(VK_LEFT),
        "right" | "arrowright" => ext(VK_RIGHT),
        "capslock" | "caps" => k(VK_CAPITAL),
        "printscreen" | "prtsc" | "snapshot" => ext(VK_SNAPSHOT),
        "pause" | "break" => k(VK_PAUSE),
        // Multimedia.
        "volumeup" | "volup" => k(VK_VOLUME_UP),
        "volumedown" | "voldown" => k(VK_VOLUME_DOWN),
        "mute" | "volumemute" => k(VK_VOLUME_MUTE),
        "playpause" | "mediaplaypause" => k(VK_MEDIA_PLAY_PAUSE),
        "nexttrack" | "medianext" => k(VK_MEDIA_NEXT_TRACK),
        "prevtrack" | "mediaprev" => k(VK_MEDIA_PREV_TRACK),
        "mediastop" => k(VK_MEDIA_STOP),
        // OEM punctuation (US layout positions).
        ";" | "semicolon" => k(0xBA),
        "=" | "equals" | "plus" => k(0xBB),
        "," | "comma" => k(0xBC),
        "-" | "minus" | "dash" => k(0xBD),
        "." | "period" | "dot" => k(0xBE),
        "/" | "slash" => k(0xBF),
        "`" | "backtick" | "grave" => k(0xC0),
        "[" | "lbracket" => k(0xDB),
        "\\" | "backslash" => k(0xDC),
        "]" | "rbracket" => k(0xDD),
        "'" | "quote" | "apostrophe" => k(0xDE),
        _ => return None,
    })
}

/// True if this key is a modifier (used when ordering a combo).
pub fn is_modifier(key: Key) -> bool {
    matches!(
        key.vk,
        VK_CONTROL
            | VK_LCONTROL
            | VK_RCONTROL
            | VK_MENU
            | VK_LMENU
            | VK_RMENU
            | VK_SHIFT
            | VK_LSHIFT
            | VK_RSHIFT
            | VK_LWIN
            | VK_RWIN
    )
}

/// Parse a combo written as `"Ctrl+Shift+Esc"` into its component names.
pub fn split_combo(spec: &str) -> Vec<String> {
    spec.split('+')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_and_digits() {
        assert_eq!(resolve("a"), Some(k(b'A' as u16)));
        assert_eq!(resolve("Z"), Some(k(b'Z' as u16)));
        assert_eq!(resolve("5"), Some(k(b'5' as u16)));
    }

    #[test]
    fn function_keys() {
        assert_eq!(resolve("f1"), Some(k(0x70)));
        assert_eq!(resolve("F12"), Some(k(0x7B)));
        assert_eq!(resolve("f24"), Some(k(0x87)));
        assert_eq!(resolve("f25"), None);
    }

    #[test]
    fn extended_keys_set_the_bit() {
        assert!(resolve("up").unwrap().extended);
        assert!(resolve("delete").unwrap().extended);
        assert!(resolve("win").unwrap().extended);
        assert!(!resolve("enter").unwrap().extended);
    }

    #[test]
    fn modifiers_detected() {
        assert!(is_modifier(resolve("ctrl").unwrap()));
        assert!(is_modifier(resolve("shift").unwrap()));
        assert!(!is_modifier(resolve("a").unwrap()));
    }

    #[test]
    fn unknown_is_none() {
        assert_eq!(resolve("floopy"), None);
    }

    #[test]
    fn combo_splitting() {
        assert_eq!(split_combo("Ctrl+Shift+Esc"), vec!["Ctrl", "Shift", "Esc"]);
        assert_eq!(split_combo("Alt + F4"), vec!["Alt", "F4"]);
    }
}
