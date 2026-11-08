//! `~/.tendril/settings.json`: the user's settings.
//!
//! Every field has a default (`#[serde(default)]`), so a file written by an
//! older version - or a hand-written file with only the fields someone cares
//! about - keeps working, and a future version can add fields freely. Keys
//! this version does not know are kept in [`Settings::extra`] and written back
//! untouched, so running an older binary never erases a newer one's settings.
//!
//! The file is created with the defaults when it does not exist. A file that
//! is not valid JSON stops the start-up with the line and column of the error:
//! silently ignoring it could, for instance, drop the user's password.
//!
//! The Settings tab edits this file through [`SettingsStore::apply_patch`],
//! a JSON merge patch (RFC 7386) that is validated before it is saved.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::core::jsonfile::{self, JsonFileError};
use crate::core::lock::RwLockExt;

/// Default HTTP(S) port.
pub const DEFAULT_PORT: u16 = 6060;
/// Default idle timeout: three hours.
pub const DEFAULT_IDLE_MINUTES: u64 = 180;
/// The idle timeout cannot be disabled; one minute is the minimum.
pub const MIN_IDLE_MINUTES: u64 = 1;
/// Upper bound that keeps millisecond arithmetic far from overflow while
/// still allowing a value high enough to "virtually disable" the timeout
/// (about 1,900 years).
pub const MAX_IDLE_MINUTES: u64 = 1_000_000_000;

/// Which code editor the browser uses.
pub const EDITORS: &[&str] = &["codemirror", "monaco"];

/// All user settings. Field names are the JSON keys.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Login password. `--password` overrides it; when neither is set, a
    /// random password is generated on every start and printed once.
    pub password: Option<String>,
    /// Minutes without user activity after which the process exits.
    pub idle_timeout_minutes: u64,
    /// Port to listen on (the next free one is used when it is taken).
    pub port: u16,
    /// Address to listen on. `0.0.0.0` accepts LAN, VPN and Internet clients.
    pub bind: String,
    /// Editor used by the browser: `codemirror` or `monaco`.
    pub default_editor: String,
    /// Largest file the editor opens, in MiB.
    pub max_editor_file_mb: u64,
    /// Largest file that can be uploaded into a workspace, in MiB.
    pub max_upload_mb: u64,
    /// Terminals that may run at the same time (whole process).
    pub max_terminals: u32,
    /// Shell for new terminals. Empty: `$SHELL` or `/bin/sh` on Unix,
    /// PowerShell or `cmd.exe` on Windows.
    pub terminal_shell: String,
    /// Host names (with optional `:port`) the server answers to. Empty
    /// allows any. Defends plain-HTTP mode against DNS rebinding.
    pub allowed_hosts: Vec<String>,
    /// Days of logs to keep.
    pub log_retention_days: u32,
    /// Upper bound for the whole `logs/` directory, in MiB.
    pub log_max_total_mb: u64,
    /// Directory names skipped by "Find in Files" and "Go to File".
    pub search_exclude: Vec<String>,
    /// Editor preferences shared by both editors.
    pub editor: EditorSettings,
    /// Workbench preferences.
    pub ui: UiSettings,
    /// Keys unknown to this version, preserved verbatim.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Preferences applied to CodeMirror and Monaco alike.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EditorSettings {
    pub font_size: u32,
    /// CSS font-family; empty uses the theme's monospace stack.
    pub font_family: String,
    pub tab_size: u32,
    pub insert_spaces: bool,
    /// Guess tabs/spaces and the indent width from each file's content.
    pub detect_indentation: bool,
    pub word_wrap: bool,
    pub minimap: bool,
    pub line_numbers: bool,
    pub render_whitespace: bool,
    pub highlight_active_line: bool,
    pub auto_close_brackets: bool,
    pub cursor_blink: bool,
    pub trim_trailing_whitespace: bool,
    pub insert_final_newline: bool,
    /// `off`, `delay` (after `auto_save_delay_ms`) or `focus` (when the editor loses focus).
    pub auto_save: String,
    pub auto_save_delay_ms: u32,
}

/// Workbench preferences.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UiSettings {
    /// `left` or `right`.
    pub sidebar_side: String,
    pub show_hidden_files: bool,
    pub confirm_delete: bool,
    /// Reopen the tabs of a workspace when it is opened again.
    pub restore_tabs: bool,
    pub terminal_font_size: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            password: None,
            idle_timeout_minutes: DEFAULT_IDLE_MINUTES,
            port: DEFAULT_PORT,
            bind: "0.0.0.0".into(),
            default_editor: "codemirror".into(),
            max_editor_file_mb: 5,
            max_upload_mb: 1024,
            max_terminals: 4,
            terminal_shell: String::new(),
            allowed_hosts: Vec::new(),
            log_retention_days: 30,
            log_max_total_mb: 50,
            search_exclude: [".git", "node_modules", "target", "dist", "build", "__pycache__", ".venv", ".idea"]
                .into_iter()
                .map(String::from)
                .collect(),
            editor: EditorSettings::default(),
            ui: UiSettings::default(),
            extra: Map::new(),
        }
    }
}

impl Default for EditorSettings {
    fn default() -> Self {
        EditorSettings {
            font_size: 14,
            font_family: String::new(),
            tab_size: 4,
            insert_spaces: true,
            detect_indentation: true,
            word_wrap: false,
            minimap: false,
            line_numbers: true,
            render_whitespace: false,
            highlight_active_line: true,
            auto_close_brackets: true,
            cursor_blink: true,
            trim_trailing_whitespace: false,
            insert_final_newline: false,
            auto_save: "off".into(),
            auto_save_delay_ms: 1000,
        }
    }
}

impl Default for UiSettings {
    fn default() -> Self {
        UiSettings {
            sidebar_side: "left".into(),
            show_hidden_files: true,
            confirm_delete: true,
            restore_tabs: true,
            terminal_font_size: 13,
        }
    }
}

impl Settings {
    /// The configured password, if it is set and not blank.
    pub fn password(&self) -> Option<&str> {
        self.password.as_deref().filter(|p| !p.is_empty())
    }

    /// Checks every field; the message names the offending key.
    pub fn validate(&self) -> Result<(), String> {
        let range = |key: &str, value: u64, min: u64, max: u64| {
            if value < min || value > max { Err(format!("{key} must be between {min} and {max}")) } else { Ok(()) }
        };
        range("idle_timeout_minutes", self.idle_timeout_minutes, MIN_IDLE_MINUTES, MAX_IDLE_MINUTES)?;
        if self.port == 0 {
            // 0 would mean "any port" to the OS, which a browser user cannot find.
            return Err("port must be between 1 and 65535".into());
        }
        if self.bind.parse::<std::net::IpAddr>().is_err() {
            return Err("bind must be an IP address such as 0.0.0.0 or 127.0.0.1".into());
        }
        if !EDITORS.contains(&self.default_editor.as_str()) {
            return Err("default_editor must be \"codemirror\" or \"monaco\"".into());
        }
        range("max_editor_file_mb", self.max_editor_file_mb, 1, 512)?;
        range("max_upload_mb", self.max_upload_mb, 1, 1_048_576)?;
        range("max_terminals", self.max_terminals as u64, 0, 64)?;
        range("log_retention_days", self.log_retention_days as u64, 1, 36_500)?;
        range("log_max_total_mb", self.log_max_total_mb, 1, 1_048_576)?;
        range("editor.font_size", self.editor.font_size as u64, 6, 72)?;
        range("editor.tab_size", self.editor.tab_size as u64, 1, 16)?;
        range("editor.auto_save_delay_ms", self.editor.auto_save_delay_ms as u64, 100, 600_000)?;
        if !["off", "delay", "focus"].contains(&self.editor.auto_save.as_str()) {
            return Err("editor.auto_save must be \"off\", \"delay\" or \"focus\"".into());
        }
        if !["left", "right"].contains(&self.ui.sidebar_side.as_str()) {
            return Err("ui.sidebar_side must be \"left\" or \"right\"".into());
        }
        range("ui.terminal_font_size", self.ui.terminal_font_size as u64, 6, 72)?;
        if self.password.as_deref().is_some_and(|p| p.chars().count() > 1024) {
            return Err("password is too long (1024 characters at most)".into());
        }
        Ok(())
    }

    /// Repairs out-of-range values found in a hand-edited file, returning a
    /// warning per repaired key. Used at start-up only: the file itself is
    /// left untouched.
    pub fn repair(&mut self) -> Vec<String> {
        let defaults = Settings::default();
        let mut warnings = Vec::new();
        // Try each field on its own against the defaults, keeping the first
        // error per field, until the whole value validates.
        for _ in 0..32 {
            let Err(message) = self.validate() else { break };
            let key = message.split_whitespace().next().unwrap_or_default().to_string();
            warnings.push(format!("settings.json: {message}; using the default"));
            match key.as_str() {
                "idle_timeout_minutes" => {
                    self.idle_timeout_minutes = self.idle_timeout_minutes.clamp(MIN_IDLE_MINUTES, MAX_IDLE_MINUTES)
                }
                "port" => self.port = defaults.port,
                "bind" => self.bind = defaults.bind.clone(),
                "default_editor" => self.default_editor = defaults.default_editor.clone(),
                "max_editor_file_mb" => self.max_editor_file_mb = defaults.max_editor_file_mb,
                "max_upload_mb" => self.max_upload_mb = defaults.max_upload_mb,
                "max_terminals" => self.max_terminals = defaults.max_terminals,
                "log_retention_days" => self.log_retention_days = defaults.log_retention_days,
                "log_max_total_mb" => self.log_max_total_mb = defaults.log_max_total_mb,
                "editor.font_size" => self.editor.font_size = defaults.editor.font_size,
                "editor.tab_size" => self.editor.tab_size = defaults.editor.tab_size,
                "editor.auto_save_delay_ms" => self.editor.auto_save_delay_ms = defaults.editor.auto_save_delay_ms,
                "editor.auto_save" => self.editor.auto_save = defaults.editor.auto_save.clone(),
                "ui.sidebar_side" => self.ui.sidebar_side = defaults.ui.sidebar_side.clone(),
                "ui.terminal_font_size" => self.ui.terminal_font_size = defaults.ui.terminal_font_size,
                "password" => self.password = None,
                _ => break,
            }
        }
        warnings
    }

    /// The settings as sent to the browser: the password itself never
    /// leaves the server, only whether one is configured.
    pub fn public_json(&self) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Value::Object(map) = &mut value {
            map.remove("password");
            map.insert("password_set".into(), Value::Bool(self.password().is_some()));
        }
        value
    }
}

/// Why a settings change was refused.
#[derive(Debug)]
pub enum SettingsError {
    /// The patch produced invalid settings.
    Invalid(String),
    /// The file could not be written.
    Io(std::io::Error),
}

impl std::fmt::Display for SettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SettingsError::Invalid(msg) => write!(f, "{msg}"),
            SettingsError::Io(err) => write!(f, "could not save settings.json: {err}"),
        }
    }
}

/// The loaded settings and the file they live in.
pub struct SettingsStore {
    path: PathBuf,
    current: RwLock<Settings>,
}

/// Result of loading `settings.json` at start-up.
pub struct Loaded {
    pub store: SettingsStore,
    /// The file did not exist and was created with the defaults.
    pub created: bool,
    /// Repaired values (see [`Settings::repair`]).
    pub warnings: Vec<String>,
}

impl SettingsStore {
    /// Loads `path`, creating it with the defaults when missing.
    pub fn load(path: &Path) -> Result<Loaded, String> {
        match jsonfile::read::<Settings>(path) {
            Ok(Some(mut settings)) => {
                let warnings = settings.repair();
                Ok(Loaded { store: SettingsStore::with(path, settings), created: false, warnings })
            }
            Ok(None) => {
                let settings = Settings::default();
                jsonfile::write(path, &settings, true)
                    .map_err(|err| format!("could not create {}: {err}", path.display()))?;
                Ok(Loaded { store: SettingsStore::with(path, settings), created: true, warnings: Vec::new() })
            }
            Err(JsonFileError::Parse { line, column, message }) => Err(format!(
                "{} is not valid: line {line}, column {column}: {message}. Fix the file or delete it to recreate the defaults.",
                path.display()
            )),
            Err(JsonFileError::Io(err)) => Err(format!("could not read {}: {err}", path.display())),
        }
    }

    /// A store over already-loaded settings (tests).
    pub fn with(path: &Path, settings: Settings) -> SettingsStore {
        SettingsStore { path: path.to_path_buf(), current: RwLock::new(settings) }
    }

    /// A snapshot of the current settings.
    pub fn get(&self) -> Settings {
        self.current.read_ok().clone()
    }

    /// The file path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Applies a JSON merge patch, validates, saves and returns the new
    /// settings plus the dotted names of the keys whose value changed.
    pub fn apply_patch(&self, patch: &Value) -> Result<(Settings, Vec<String>), SettingsError> {
        if !patch.is_object() {
            return Err(SettingsError::Invalid("the body must be a JSON object".into()));
        }
        let mut guard = self.current.write_ok();
        let before = serde_json::to_value(&*guard).map_err(|e| SettingsError::Invalid(e.to_string()))?;
        let mut merged = before.clone();
        merge_patch(&mut merged, patch);
        let next: Settings =
            serde_json::from_value(merged).map_err(|e| SettingsError::Invalid(format!("invalid value: {e}")))?;
        next.validate().map_err(SettingsError::Invalid)?;
        let after = serde_json::to_value(&next).map_err(|e| SettingsError::Invalid(e.to_string()))?;
        let changed = changed_keys(&before, &after, "");
        if !changed.is_empty() {
            jsonfile::write(&self.path, &next, true).map_err(SettingsError::Io)?;
            *guard = next.clone();
        }
        Ok((next, changed))
    }
}

/// RFC 7386 JSON merge patch: objects merge recursively, `null` deletes.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    match patch {
        Value::Object(entries) => {
            if !target.is_object() {
                *target = Value::Object(Map::new());
            }
            let map = target.as_object_mut().expect("just made an object");
            for (key, value) in entries {
                if value.is_null() {
                    map.remove(key);
                } else {
                    merge_patch(map.entry(key.clone()).or_insert(Value::Null), value);
                }
            }
        }
        other => *target = other.clone(),
    }
}

/// Dotted paths of the leaves that differ between two JSON values.
fn changed_keys(before: &Value, after: &Value, prefix: &str) -> Vec<String> {
    let mut out = Vec::new();
    match (before, after) {
        (Value::Object(a), Value::Object(b)) => {
            let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
                match (a.get(key), b.get(key)) {
                    (Some(x), Some(y)) if x.is_object() && y.is_object() => out.extend(changed_keys(x, y, &path)),
                    (x, y) if x != y => out.push(path),
                    _ => {}
                }
            }
        }
        (a, b) if a != b => out.push(prefix.to_string()),
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::random;
    use serde_json::json;

    fn temp_file() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tendril-settings-{}", random::token_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn missing_file_is_created_with_defaults() {
        let path = temp_file();
        let loaded = SettingsStore::load(&path).unwrap();
        assert!(loaded.created);
        assert_eq!(loaded.store.get(), Settings::default());
        assert!(path.exists());
        assert_eq!(loaded.store.get().idle_timeout_minutes, 180);
        assert_eq!(loaded.store.get().port, 6060);
    }

    #[test]
    fn partial_files_take_defaults_and_unknown_keys_survive() {
        let path = temp_file();
        std::fs::write(&path, r#"{"password":"hunter2","future_feature":{"x":1},"editor":{"tab_size":2}}"#).unwrap();
        let loaded = SettingsStore::load(&path).unwrap();
        let s = loaded.store.get();
        assert_eq!(s.password(), Some("hunter2"));
        assert_eq!(s.editor.tab_size, 2);
        assert_eq!(s.editor.font_size, 14);
        assert_eq!(s.extra.get("future_feature"), Some(&json!({"x": 1})));

        loaded.store.apply_patch(&json!({"idle_timeout_minutes": 5})).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("future_feature"), "unknown key was dropped: {text}");
    }

    #[test]
    fn invalid_json_is_an_error_with_a_position() {
        let path = temp_file();
        std::fs::write(&path, "{\n \"port\": ,\n}").unwrap();
        let err = SettingsStore::load(&path).err().unwrap();
        assert!(err.contains("line 2"), "{err}");
    }

    #[test]
    fn out_of_range_values_are_repaired_at_load() {
        let path = temp_file();
        std::fs::write(&path, r#"{"idle_timeout_minutes":0,"default_editor":"vim"}"#).unwrap();
        let loaded = SettingsStore::load(&path).unwrap();
        assert_eq!(loaded.store.get().idle_timeout_minutes, 1);
        assert_eq!(loaded.store.get().default_editor, "codemirror");
        assert_eq!(loaded.warnings.len(), 2);
    }

    #[test]
    fn patches_are_validated_and_report_changed_keys() {
        let path = temp_file();
        let store = SettingsStore::load(&path).unwrap().store;
        let (s, changed) =
            store.apply_patch(&json!({"idle_timeout_minutes": 30, "editor": {"word_wrap": true}})).unwrap();
        assert_eq!(s.idle_timeout_minutes, 30);
        assert_eq!(changed, vec!["editor.word_wrap".to_string(), "idle_timeout_minutes".to_string()]);

        // The idle timeout cannot be disabled.
        assert!(matches!(store.apply_patch(&json!({"idle_timeout_minutes": 0})), Err(SettingsError::Invalid(_))));
        // But it may be set very high.
        assert!(store.apply_patch(&json!({"idle_timeout_minutes": 100_000_000})).is_ok());
        assert!(store.apply_patch(&json!({"default_editor": "emacs"})).is_err());
        assert!(store.apply_patch(&json!("nope")).is_err());

        // null clears the password.
        store.apply_patch(&json!({"password": "abc"})).unwrap();
        assert_eq!(store.get().password(), Some("abc"));
        store.apply_patch(&json!({"password": null})).unwrap();
        assert_eq!(store.get().password(), None);
    }

    #[test]
    fn the_password_never_reaches_the_browser() {
        let s = Settings { password: Some("secret".into()), ..Settings::default() };
        let json = s.public_json();
        assert!(json.get("password").is_none());
        assert_eq!(json["password_set"], json!(true));
        assert!(!json.to_string().contains("secret"));
    }
}
