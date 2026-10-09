//! Export, import, reset and the automatic backups that guard them.
//!
//! Export produces a single JSON object holding `config.json` and every MASKED
//! category. Import takes that object back, either merging it with what exists
//! or replacing it. Before any import or reset the current `user-data` is
//! snapshotted into `backups\<timestamp>\`, and old snapshots are rotated.

use crate::config::default_config;
use crate::json::{self, Obj, Value};
use crate::paths::{write_atomic, Paths};
use crate::state::{AppState, CATEGORIES, CONFIG_FILE};
use crate::win::sysinfo::local_time;
use std::sync::Arc;

const APP_TAG: &str = "AllySwally";
const MAX_BACKUPS: usize = 30;

/// Build the export bundle from the live store.
pub fn export(state: &Arc<AppState>) -> Value {
    let mut categories = Obj::new();
    for category in CATEGORIES {
        categories = categories.set(category, state.store.get(&AppState::category_file(category)));
    }
    Obj::new()
        .str("app", APP_TAG)
        .str("version", state.version)
        .str("exportedAt", local_time().timestamp())
        .set("config", state.config_value())
        .set("categories", categories.build())
        .build()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ImportMode {
    Combine,
    Replace,
}

impl ImportMode {
    pub fn parse(s: &str) -> Option<ImportMode> {
        match s {
            "combine" => Some(ImportMode::Combine),
            "replace" => Some(ImportMode::Replace),
            _ => None,
        }
    }
}

/// Apply an import bundle. Backs up first, then writes config and each category
/// according to `mode`. Returns the list of files written.
pub fn import(state: &Arc<AppState>, mode: ImportMode, bundle: &Value) -> std::io::Result<Vec<String>> {
    backup(&state.paths)?;
    let mut written = Vec::new();

    if let Some(incoming_config) = bundle.get("config") {
        let new_config = match mode {
            ImportMode::Replace => incoming_config.clone(),
            ImportMode::Combine => {
                let mut base = state.config_value();
                json::merge(&mut base, incoming_config);
                base
            }
        };
        state.store.save(CONFIG_FILE, new_config)?;
        written.push(CONFIG_FILE.to_string());
    }

    if let Some(incoming_categories) = bundle.get("categories") {
        for category in CATEGORIES {
            if let Some(incoming) = incoming_categories.get(category) {
                let file = AppState::category_file(category);
                let new_list = match mode {
                    ImportMode::Replace => incoming.clone(),
                    ImportMode::Combine => merge_items(&state.store.get(&file), incoming),
                };
                state.store.save(&file, new_list)?;
                written.push(file);
            }
        }
    }
    Ok(written)
}

/// Reset the host data: back up, then restore `config.json` to its defaults and
/// empty every category.
pub fn reset_host(state: &Arc<AppState>) -> std::io::Result<()> {
    backup(&state.paths)?;
    state.store.save(CONFIG_FILE, default_config())?;
    for category in CATEGORIES {
        state
            .store
            .save(&AppState::category_file(category), Value::Array(vec![]))?;
    }
    Ok(())
}

/// Merge two item arrays by `id`: existing items with a matching id are
/// replaced, new ids are appended.
fn merge_items(existing: &Value, incoming: &Value) -> Value {
    let mut out: Vec<Value> = existing.as_array().map(|a| a.to_vec()).unwrap_or_default();
    if let Some(incoming_items) = incoming.as_array() {
        for item in incoming_items {
            let id = item.get_str("id");
            match id.and_then(|id| out.iter().position(|e| e.get_str("id") == Some(id))) {
                Some(idx) => out[idx] = item.clone(),
                None => out.push(item.clone()),
            }
        }
    }
    Value::Array(out)
}

/// Snapshot the current `user-data` files into `backups\<timestamp>\`, then
/// rotate old snapshots. Best effort for individual files; the directory is
/// created up front.
pub fn backup(paths: &Paths) -> std::io::Result<()> {
    let stamp = local_time().stamp_for_filename();
    let dir = paths.backups.join(&stamp);
    std::fs::create_dir_all(&dir)?;

    let mut files = vec![CONFIG_FILE.to_string()];
    files.extend(CATEGORIES.iter().map(|c| AppState::category_file(c)));
    for name in files {
        let src = paths.user_data_file(&name);
        if let Ok(contents) = std::fs::read(&src) {
            let _ = write_atomic(&dir.join(&name), &contents);
        }
    }
    rotate_backups(paths);
    Ok(())
}

/// Keep only the newest [`MAX_BACKUPS`] snapshot directories.
fn rotate_backups(paths: &Paths) {
    let mut dirs: Vec<_> = match std::fs::read_dir(&paths.backups) {
        Ok(entries) => entries
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => return,
    };
    // Names are `YYYY-MM-DD_HH-MM-SS`, so lexicographic order is chronological.
    dirs.sort();
    while dirs.len() > MAX_BACKUPS {
        let oldest = dirs.remove(0);
        let _ = std::fs::remove_dir_all(paths.backups.join(oldest));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_mode_parsing() {
        assert_eq!(ImportMode::parse("combine"), Some(ImportMode::Combine));
        assert_eq!(ImportMode::parse("replace"), Some(ImportMode::Replace));
        assert_eq!(ImportMode::parse("nope"), None);
    }

    #[test]
    fn merge_items_replaces_and_appends() {
        let existing = Value::Array(vec![
            Obj::new().str("id", "a").str("name", "A").build(),
            Obj::new().str("id", "b").str("name", "B").build(),
        ]);
        let incoming = Value::Array(vec![
            Obj::new().str("id", "a").str("name", "A2").build(),
            Obj::new().str("id", "c").str("name", "C").build(),
        ]);
        let merged = merge_items(&existing, &incoming);
        let items = merged.as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].get_str("name"), Some("A2")); // replaced
        assert_eq!(items[1].get_str("name"), Some("B")); // kept
        assert_eq!(items[2].get_str("name"), Some("C")); // appended
    }
}
