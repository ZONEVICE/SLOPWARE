//! Directory traversal.
//!
//! Two shapes of the same walk:
//!  - `walk_tree` returns a flat list of wire path -> state. It seeds the
//!    host's index, builds the manifest a syncing peer downloads, and lists the
//!    local side before a reconciliation.
//!  - `build_tree` returns the nested structure the interface renders as the
//!    checkbox tree of the "Host a directory" screen.
//!
//! Symlinks are never followed. Reptile's own temporary files are always left
//! out, so a half-received file is never listed or re-sent.

use crate::fs::entry::{read_dir_states, Kind, State};
use crate::util::wire::{join, sort_paths};
use serde_json::{json, Map, Value};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

/// What a walk filter decides for one entry.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Include,
    /// Leave out the entry and, for a directory, everything below it.
    Prune,
    /// Leave out the entry itself only.
    Skip,
}

/// Decides, per entry, what the walk keeps.
pub type WalkFilter<'a> = &'a dyn Fn(&str, &State) -> Decision;
/// Told about each subdirectory that could not be read.
pub type WalkErrors<'a> = &'a mut dyn FnMut(&io::Error, &str);

pub struct WalkOptions<'a> {
    pub filter: Option<WalkFilter<'a>>,
    /// Include symlinks and special files as `Kind::Other`.
    pub include_other: bool,
    /// Unreadable subdirectories.
    pub on_error: Option<WalkErrors<'a>>,
    /// Stop after this many entries.
    pub limit: usize,
}

impl Default for WalkOptions<'_> {
    fn default() -> Self {
        WalkOptions { filter: None, include_other: false, on_error: None, limit: usize::MAX }
    }
}

pub struct Walk {
    pub entries: Vec<(String, State)>,
    pub truncated: bool,
}

fn absolute_of(root: &Path, wire: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    if !wire.is_empty() {
        for segment in wire.split('/') {
            path.push(segment);
        }
    }
    path
}

/// Walk a directory tree. An unreadable root is an error; an unreadable
/// subdirectory is reported through `on_error` and skipped.
pub fn walk_tree(root: &Path, mut options: WalkOptions<'_>) -> io::Result<Walk> {
    let mut entries = Vec::new();
    let mut stack = vec![String::new()];
    while let Some(dir_wire) = stack.pop() {
        let listing = match read_dir_states(&absolute_of(root, &dir_wire)) {
            Ok(listing) => listing,
            Err(error) if dir_wire.is_empty() => return Err(error),
            Err(error) => {
                if let Some(on_error) = options.on_error.as_mut() {
                    on_error(&error, &dir_wire);
                }
                continue;
            }
        };
        for (name, state) in listing {
            let wire = join(&dir_wire, &name);
            if state.kind == Kind::Other && !options.include_other {
                continue;
            }
            let decision = options.filter.map(|filter| filter(&wire, &state)).unwrap_or(Decision::Include);
            if decision == Decision::Prune {
                continue;
            }
            if decision != Decision::Skip {
                if entries.len() >= options.limit {
                    return Ok(Walk { entries, truncated: true });
                }
                entries.push((wire.clone(), state));
            }
            if state.kind == Kind::Dir {
                stack.push(wire);
            }
        }
    }
    Ok(Walk { entries, truncated: false })
}

/// Shorthand: every syncable entry, no filter.
pub fn walk_all(root: &Path) -> io::Result<Vec<(String, State)>> {
    walk_tree(root, WalkOptions::default()).map(|walk| walk.entries)
}

// --- The checkbox tree -------------------------------------------------------------

struct TreeNode {
    name: String,
    path: String,
    kind: Kind,
    size: Option<u64>,
    children: Option<Vec<usize>>,
    error: Option<String>,
}

/// Natural order, case-insensitive: "file2" before "file10", like
/// `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`.
pub fn natural_compare(a: &str, b: &str) -> Ordering {
    fn chunks(text: &str) -> Vec<(bool, String)> {
        let mut out: Vec<(bool, String)> = Vec::new();
        for c in text.chars() {
            let digit = c.is_ascii_digit();
            match out.last_mut() {
                Some((is_digit, chunk)) if *is_digit == digit => chunk.push(c),
                _ => out.push((digit, c.to_string())),
            }
        }
        out
    }
    let (left, right) = (chunks(a), chunks(b));
    for (l, r) in left.iter().zip(&right) {
        let order = match (l.0, r.0) {
            (true, true) => {
                let (lt, rt) = (l.1.trim_start_matches('0'), r.1.trim_start_matches('0'));
                lt.len().cmp(&rt.len()).then_with(|| lt.cmp(rt))
            }
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => l.1.to_lowercase().cmp(&r.1.to_lowercase()),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    left.len().cmp(&right.len())
}

/// The nested tree of the content-selection step. Every node carries its wire
/// path so the browser can send exclusions back verbatim. Directories come
/// first, then files, each group in natural order. Links and special files
/// are listed but flagged, so the user is not surprised later.
pub fn build_tree(root: &Path, limit: usize) -> io::Result<(Value, usize, bool)> {
    let mut errors: HashMap<String, String> = HashMap::new();
    let mut record = |error: &io::Error, wire: &str| {
        let message = if error.kind() == io::ErrorKind::PermissionDenied {
            "Permission denied".to_string()
        } else {
            error.to_string()
        };
        errors.insert(wire.to_string(), message);
    };
    let walk = walk_tree(root, WalkOptions { filter: None, include_other: true, on_error: Some(&mut record), limit })?;
    let total = walk.entries.len();
    let states: HashMap<String, State> = walk.entries.into_iter().collect();

    let mut nodes = vec![TreeNode {
        name: String::new(),
        path: String::new(),
        kind: Kind::Dir,
        size: None,
        children: Some(vec![]),
        error: None,
    }];
    let mut by_path: HashMap<String, usize> = HashMap::from([(String::new(), 0)]);
    for path in sort_paths(states.keys().cloned()) {
        let state = states[&path];
        let (parent_path, name) = match path.rfind('/') {
            Some(index) => (&path[..index], &path[index + 1..]),
            None => ("", path.as_str()),
        };
        let Some(&parent) = by_path.get(parent_path) else { continue };
        let index = nodes.len();
        nodes.push(TreeNode {
            name: name.to_string(),
            path: path.clone(),
            kind: state.kind,
            size: (state.kind == Kind::File).then_some(state.size),
            children: (state.kind == Kind::Dir).then(Vec::new),
            error: if state.kind == Kind::Dir { errors.get(&path).cloned() } else { None },
        });
        if let Some(children) = nodes[parent].children.as_mut() {
            children.push(index);
        }
        by_path.insert(path, index);
    }

    fn to_json(nodes: &[TreeNode], index: usize) -> Value {
        let node = &nodes[index];
        let mut object = Map::new();
        object.insert("name".into(), json!(node.name));
        object.insert("path".into(), json!(node.path));
        object.insert("kind".into(), json!(node.kind.as_str()));
        if let Some(size) = node.size {
            object.insert("size".into(), json!(size));
        }
        if let Some(children) = &node.children {
            let mut order = children.clone();
            order.sort_by(|a, b| {
                let rank = |i: &usize| if nodes[*i].kind == Kind::Dir { 0 } else { 1 };
                rank(a).cmp(&rank(b)).then_with(|| natural_compare(&nodes[*a].name, &nodes[*b].name))
            });
            object.insert(
                "children".into(),
                Value::Array(order.into_iter().map(|child| to_json(nodes, child)).collect()),
            );
            if let Some(error) = &node.error {
                object.insert("error".into(), json!(error));
            }
        }
        Value::Object(object)
    }
    Ok((to_json(&nodes, 0), total, walk.truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order() {
        let mut names = vec!["file10", "File2", "file1", "a", "B"];
        names.sort_by(|a, b| natural_compare(a, b));
        assert_eq!(names, vec!["a", "B", "file1", "File2", "file10"]);
    }
}
