//! Content selection on the host: which paths are shared.
//!
//! The model is a set of EXCLUDED wire paths, the items the user unchecked in
//! the tree. A path is shared unless it or one of its ancestors is excluded.
//! Files created after hosting started are shared unless they land inside an
//! unchecked directory.
//!
//! "Unchecked items never leave the host and are never modified from the other
//! side" is enforced in two places: outgoing (manifest, file endpoint, live
//! feed all filter through `is_excluded`) and incoming (every operation a peer
//! sends is refused with `not_shared` when it touches an excluded path).
//!
//! An unchecked item stays unchecked when the host renames or moves it:
//! exclusions are recorded by path AND by identity (device + inode).

use crate::domain::errors::{AppError, AppResult};
use crate::fs::entry::Identity;
use crate::util::wire::{is_same_or_inside, is_strictly_inside, normalize, parent_of, rebase};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

/// Validate and simplify a list of excluded paths from the interface.
/// Entries below another excluded entry are redundant and dropped; the root
/// itself cannot be excluded (that would share nothing at all).
pub fn normalize_exclusions(list: Option<&Value>) -> AppResult<Vec<String>> {
    let items = match list {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(AppError::bad_request("The excluded list must be an array of paths.", "bad_selection")),
    };
    let mut paths = BTreeSet::new();
    for item in items {
        let normalized = item.as_str().and_then(|text| normalize(text, true));
        match normalized {
            None => {
                let shown = match item {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                };
                return Err(AppError::bad_request(format!("Invalid path in the selection: {shown}"), "bad_selection"));
            }
            Some(path) if path.is_empty() => {
                return Err(AppError::bad_request("Select at least one item to share.", "empty_selection"));
            }
            Some(path) => {
                paths.insert(path);
            }
        }
    }
    let sorted: Vec<String> = paths.into_iter().collect();
    Ok(sorted
        .iter()
        .filter(|path| !sorted.iter().any(|other| other != *path && is_strictly_inside(other, path)))
        .cloned()
        .collect())
}

#[derive(Debug, Clone, Default)]
pub struct Selection {
    excluded: BTreeSet<String>,
    identities: HashMap<Identity, String>,
}

impl Selection {
    pub fn new(excluded: Vec<String>) -> Selection {
        Selection { excluded: excluded.into_iter().collect(), identities: HashMap::new() }
    }

    pub fn from_input(list: Option<&Value>) -> AppResult<Selection> {
        Ok(Selection::new(normalize_exclusions(list)?))
    }

    pub fn len(&self) -> usize {
        self.excluded.len()
    }

    pub fn is_empty(&self) -> bool {
        self.excluded.is_empty()
    }

    /// Explicit exclusions, sorted.
    pub fn list(&self) -> Vec<String> {
        self.excluded.iter().cloned().collect()
    }

    /// True when `path` is not shared.
    pub fn is_excluded(&self, path: &str) -> bool {
        if self.excluded.is_empty() || path.is_empty() {
            return false;
        }
        let mut current = path;
        while !current.is_empty() {
            if self.excluded.contains(current) {
                return true;
            }
            current = parent_of(current);
        }
        false
    }

    /// True when a proper ancestor of `path` is excluded.
    pub fn has_excluded_ancestor(&self, path: &str) -> bool {
        if self.excluded.is_empty() || path.is_empty() {
            return false;
        }
        let mut current = parent_of(path);
        while !current.is_empty() {
            if self.excluded.contains(current) {
                return true;
            }
            current = parent_of(current);
        }
        false
    }

    /// True when something strictly below `path` is excluded.
    pub fn has_exclusions_inside(&self, path: &str) -> bool {
        self.excluded.iter().any(|entry| is_strictly_inside(path, entry))
    }

    /// Remember the identity of an excluded item so it can be recognised after
    /// a rename.
    pub fn bind_identity(&mut self, path: &str, id: Option<Identity>) {
        if let Some(id) = id {
            self.identities.insert(id, path.to_string());
        }
    }

    /// An item with this identity appeared at `path`. If it is an unchecked
    /// item that moved, keep it unchecked at its new location.
    pub fn follow_identity(&mut self, path: &str, id: Option<Identity>) -> bool {
        let Some(id) = id else { return false };
        let Some(previous) = self.identities.get(&id) else { return false };
        if previous == path || self.excluded.contains(path) {
            return false;
        }
        self.excluded.insert(path.to_string());
        self.identities.insert(id, path.to_string());
        true
    }

    /// The host renamed `from` to `to`: exclusions at or below `from` follow.
    /// Old entries are kept on purpose: a new item later created under the old
    /// name stays unshared, which errs on the side of privacy.
    pub fn apply_rename(&mut self, from: &str, to: &str) -> bool {
        let mut changed = false;
        let inherited = !self.excluded.contains(from) && self.has_excluded_ancestor(from);
        let moved: Vec<String> = self
            .excluded
            .iter()
            .filter(|entry| is_same_or_inside(from, entry))
            .map(|entry| rebase(entry, from, to))
            .collect();
        for path in moved {
            if self.excluded.insert(path) {
                changed = true;
            }
        }
        if inherited && !self.is_excluded(to) {
            self.excluded.insert(to.to_string());
            changed = true;
        }
        for path in self.identities.values_mut() {
            if is_same_or_inside(from, path) {
                *path = rebase(path, from, to);
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exclusions_are_normalised() {
        assert_eq!(normalize_exclusions(Some(&json!(["a/b", "a", "c/"]))).unwrap(), vec!["a", "c"]);
        assert_eq!(normalize_exclusions(Some(&json!([""]))).unwrap_err().code, "empty_selection");
        assert_eq!(normalize_exclusions(Some(&json!(["../x"]))).unwrap_err().code, "bad_selection");
        assert_eq!(normalize_exclusions(Some(&json!("a"))).unwrap_err().code, "bad_selection");
        assert!(normalize_exclusions(None).unwrap().is_empty());
    }

    #[test]
    fn rules() {
        let mut selection = Selection::new(vec!["secret".into(), "docs/private".into()]);
        assert!(selection.is_excluded("secret"));
        assert!(selection.is_excluded("secret/x"));
        assert!(!selection.is_excluded("docs"));
        assert!(selection.has_excluded_ancestor("docs/private/a"));
        assert!(!selection.has_excluded_ancestor("docs/private"));
        assert!(selection.has_exclusions_inside("docs"));
        selection.bind_identity("secret", Some((1, 9)));
        assert!(selection.follow_identity("renamed", Some((1, 9))));
        assert!(selection.is_excluded("renamed"));
        assert!(selection.apply_rename("docs", "papers"));
        assert!(selection.is_excluded("papers/private/a"));
    }
}
