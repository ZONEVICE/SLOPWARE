//! Persistence for the config and MASKED data, as human-editable JSON files.
//!
//! This is the single persistence seam. Every file under `user-data` is managed
//! here: `config.json` plus the four MASKED categories (`shortcuts.json`,
//! `launchers.json`, `clipboard.json`, `scripts.json`). The store:
//!
//! * seeds a default file on first run;
//! * reloads a file when its `mtime` changes (hot reload), and on demand;
//! * writes atomically (temp file + rename) so a hand-editor never sees a
//!   half-written file;
//! * tolerates human error — if an edited file is invalid JSON, the last valid
//!   value is kept in memory, the parse error (with line and column) is
//!   recorded for Diagnostics, and the broken file is **never** overwritten.
//!
//! Adding a new persisted category is one `ensure` call at startup plus a
//! handler that reads and writes it by name; no other file changes.

use crate::json::{self, Value};
use crate::paths::write_atomic;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

/// A parse failure on a hand-edited file, surfaced in Diagnostics.
#[derive(Clone, Debug, PartialEq)]
pub struct JsonFileError {
    pub file: String,
    pub message: String,
    pub line: usize,
    pub column: usize,
}

struct FileState {
    value: Value,
    mtime: Option<SystemTime>,
    error: Option<JsonFileError>,
}

pub struct Store {
    dir: PathBuf,
    files: Mutex<HashMap<String, FileState>>,
}

impl Store {
    pub fn new(dir: PathBuf) -> Store {
        Store {
            dir,
            files: Mutex::new(HashMap::new()),
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// Register a managed file, seeding `default` if it does not exist, then
    /// loading whatever is on disk. Called once per category at startup.
    pub fn ensure(&self, name: &str, default: Value) {
        let path = self.path(name);
        if !path.exists() {
            let _ = write_atomic(&path, default.to_pretty().as_bytes());
        }
        let (value, mtime, error) = self.read_from_disk(name, &default);
        self.files.lock().unwrap().insert(
            name.to_string(),
            FileState {
                value,
                mtime,
                error,
            },
        );
    }

    /// Read + parse a file, returning the value to keep (parsed, or the
    /// provided fallback on error), the mtime, and any parse error.
    fn read_from_disk(
        &self,
        name: &str,
        fallback: &Value,
    ) -> (Value, Option<SystemTime>, Option<JsonFileError>) {
        let path = self.path(name);
        let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        match std::fs::read_to_string(&path) {
            Ok(text) => match json::parse(&text) {
                Ok(v) => (v, mtime, None),
                Err(e) => (
                    fallback.clone(),
                    mtime,
                    Some(JsonFileError {
                        file: name.to_string(),
                        message: e.message,
                        line: e.line,
                        column: e.column,
                    }),
                ),
            },
            Err(_) => (fallback.clone(), mtime, None),
        }
    }

    /// The last valid value of a managed file.
    pub fn get(&self, name: &str) -> Value {
        self.files
            .lock()
            .unwrap()
            .get(name)
            .map(|f| f.value.clone())
            .unwrap_or(Value::Null)
    }

    /// Reload a file if its mtime changed since last seen. Returns true when a
    /// reload happened (whether it parsed or not). A parse failure keeps the
    /// previous value and records the error.
    pub fn reload_if_changed(&self, name: &str) -> bool {
        let path = self.path(name);
        let current_mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        let changed = {
            let files = self.files.lock().unwrap();
            match files.get(name) {
                Some(f) => f.mtime != current_mtime,
                None => true,
            }
        };
        if !changed {
            return false;
        }
        let fallback = self.get(name);
        let (value, mtime, error) = self.read_from_disk(name, &fallback);
        let mut files = self.files.lock().unwrap();
        if let Some(f) = files.get_mut(name) {
            // On a parse error keep the previous (valid) value; otherwise adopt
            // the freshly parsed one.
            if error.is_none() {
                f.value = value;
            }
            f.mtime = mtime;
            f.error = error;
        }
        true
    }

    /// Reload every managed file that changed. Returns the names reloaded.
    pub fn reload_all_changed(&self) -> Vec<String> {
        let names: Vec<String> = self.files.lock().unwrap().keys().cloned().collect();
        let mut reloaded = Vec::new();
        for name in names {
            if self.reload_if_changed(&name) {
                reloaded.push(name);
            }
        }
        reloaded
    }

    /// Persist a value for a managed file: atomic pretty-printed write, then
    /// adopt it in memory and refresh the mtime so the writer's own change does
    /// not look like an external edit on the next poll.
    pub fn save(&self, name: &str, value: Value) -> std::io::Result<()> {
        let path = self.path(name);
        write_atomic(&path, value.to_pretty().as_bytes())?;
        let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        let mut files = self.files.lock().unwrap();
        files.insert(
            name.to_string(),
            FileState {
                value,
                mtime,
                error: None,
            },
        );
        Ok(())
    }

    /// All current parse errors across managed files.
    pub fn errors(&self) -> Vec<JsonFileError> {
        self.files
            .lock()
            .unwrap()
            .values()
            .filter_map(|f| f.error.clone())
            .collect()
    }

    /// Names of all managed files (for export and reset).
    pub fn names(&self) -> Vec<String> {
        self.files.lock().unwrap().keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::{Obj, Value};

    fn temp_dir() -> PathBuf {
        let mut dir = std::env::temp_dir();
        let unique = format!(
            "allyswally-store-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        dir.push(unique);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn seeds_and_reads_default() {
        let dir = temp_dir();
        let store = Store::new(dir.clone());
        let default = Obj::new().num("version", 1).build();
        store.ensure("config.json", default);
        assert_eq!(store.get("config.json").get_i64("version"), Some(1));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_then_get_roundtrips() {
        let dir = temp_dir();
        let store = Store::new(dir.clone());
        store.ensure("shortcuts.json", Value::Array(vec![]));
        let v = Value::Array(vec![Obj::new().str("name", "Copy").build()]);
        store.save("shortcuts.json", v).unwrap();
        let got = store.get("shortcuts.json");
        assert_eq!(got.as_array().unwrap().len(), 1);
        assert_eq!(got.as_array().unwrap()[0].get_str("name"), Some("Copy"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn invalid_edit_keeps_last_value_and_records_error() {
        let dir = temp_dir();
        let store = Store::new(dir.clone());
        store.ensure("scripts.json", Value::Array(vec![]));
        // Write a valid value first.
        store
            .save("scripts.json", Value::Array(vec![Value::Num(1.0)]))
            .unwrap();
        // Corrupt the file by hand and force a reload by clearing the mtime.
        let path = dir.join("scripts.json");
        std::fs::write(&path, b"{ this is not json").unwrap();
        // Make the mtime differ.
        store.reload_if_changed("scripts.json");
        // Value is preserved, and an error is recorded.
        assert_eq!(store.get("scripts.json").as_array().unwrap().len(), 1);
        let errors = store.errors();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].file, "scripts.json");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fixing_the_file_clears_the_error() {
        let dir = temp_dir();
        let store = Store::new(dir.clone());
        store.ensure("launchers.json", Value::Array(vec![]));
        let path = dir.join("launchers.json");
        std::fs::write(&path, b"broken").unwrap();
        store.reload_if_changed("launchers.json");
        assert_eq!(store.errors().len(), 1);
        // Repair it.
        std::fs::write(&path, b"[]").unwrap();
        store.reload_if_changed("launchers.json");
        assert!(store.errors().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
