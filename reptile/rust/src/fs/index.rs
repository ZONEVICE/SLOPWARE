//! An in-memory map of wire path -> entry state, with an identity lookup and a
//! parent -> children map.
//!
//! Both sides keep one, with slightly different meanings:
//!  - the host's index is the state it last observed and announced;
//!  - the syncing side's index is the state it last knew to be identical on
//!    both machines (the "base" of the three-way comparison in the planner).
//!
//! In both cases the watcher diffs the disk against it to find changes, and the
//! identity lookup lets it recognise renames. The children map keeps subtree
//! operations (a deleted or renamed directory) proportional to the subtree.

use crate::fs::entry::{Identity, Kind, State};
use crate::fs::ops::SyncOp;
use crate::util::wire::{parent_of, rebase};
use std::collections::{HashMap, HashSet};

#[derive(Default, Debug, Clone)]
pub struct FileIndex {
    entries: HashMap<String, State>,
    identities: HashMap<Identity, String>,
    /// Parent -> children, with "virtual" parents for ancestors that are not
    /// entries themselves, so every entry is reachable from every ancestor.
    children: HashMap<String, HashSet<String>>,
}

impl FileIndex {
    pub fn new() -> FileIndex {
        FileIndex::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, path: &str) -> Option<&State> {
        self.entries.get(path)
    }

    pub fn has(&self, path: &str) -> bool {
        self.entries.contains_key(path)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &State)> {
        self.entries.iter()
    }

    /// Direct children of `path` (entries or virtual ancestors).
    pub fn children_of(&self, path: &str) -> Vec<String> {
        self.children.get(path).map(|set| set.iter().cloned().collect()).unwrap_or_default()
    }

    pub fn set(&mut self, path: &str, state: State) {
        let stored = State { size: if state.kind == Kind::File { state.size } else { 0 }, ..state };
        let previous = self.entries.insert(path.to_string(), stored);
        match previous {
            Some(previous) => self.forget_identity(path, &previous),
            None => self.link(path),
        }
        if let Some(id) = stored.id {
            self.identities.insert(id, path.to_string());
        }
    }

    /// Forget one path (not its descendants).
    pub fn delete(&mut self, path: &str) {
        if let Some(previous) = self.entries.remove(path) {
            self.forget_identity(path, &previous);
            self.unlink(path);
        }
    }

    /// Forget a path and everything below it.
    pub fn delete_tree(&mut self, path: &str) {
        for (child, _) in self.descendants(path) {
            self.delete(&child);
        }
        self.delete(path);
    }

    /// Entries strictly below `path`, parents before children.
    pub fn descendants(&self, path: &str) -> Vec<(String, State)> {
        let mut out = Vec::new();
        let mut stack: Vec<&String> = match self.children.get(path) {
            Some(set) => set.iter().collect(),
            None => return out,
        };
        while let Some(child) = stack.pop() {
            if let Some(state) = self.entries.get(child) {
                out.push((child.clone(), *state));
            }
            if let Some(below) = self.children.get(child) {
                stack.extend(below.iter());
            }
        }
        out
    }

    /// Which path currently holds this identity, if any.
    pub fn path_for_identity(&self, id: Option<Identity>) -> Option<&str> {
        let id = id?;
        let path = self.identities.get(&id)?;
        // Guard against a stale mapping left behind by an overwrite.
        (self.entries.get(path).and_then(|s| s.id) == Some(id)).then_some(path.as_str())
    }

    /// Move a path and all of its descendants, keeping their states (a rename
    /// keeps sizes, mtimes and inodes). Whatever was at the destination is
    /// replaced, as rename(2) would do.
    pub fn rekey(&mut self, from: &str, to: &str) {
        if from == to {
            return;
        }
        let mut moving = Vec::new();
        if let Some(own) = self.entries.get(from) {
            moving.push((from.to_string(), *own));
        }
        moving.extend(self.descendants(from));
        for (path, _) in &moving {
            self.delete(path);
        }
        self.delete_tree(to);
        for (path, state) in moving {
            self.set(&rebase(&path, from, to), state);
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.identities.clear();
        self.children.clear();
    }

    pub fn replace_all(&mut self, entries: impl IntoIterator<Item = (String, State)>) {
        self.clear();
        for (path, state) in entries {
            self.set(&path, state);
        }
    }

    /// A snapshot with only peer-relevant fields.
    pub fn to_public_map(&self) -> HashMap<String, State> {
        self.entries.iter().map(|(path, state)| (path.clone(), state.public())).collect()
    }

    fn link(&mut self, path: &str) {
        let mut child = path.to_string();
        while !child.is_empty() {
            let parent = parent_of(&child).to_string();
            let set = self.children.entry(parent.clone()).or_default();
            if !set.insert(child) {
                return; // the rest of the chain is already linked
            }
            child = parent;
        }
    }

    /// Unlink a path that is no entry and has no children, then its empty
    /// virtual ancestors.
    fn unlink(&mut self, path: &str) {
        let mut child = path.to_string();
        while !child.is_empty() {
            if self.entries.contains_key(&child) || self.children.contains_key(&child) {
                return;
            }
            let parent = parent_of(&child).to_string();
            let Some(set) = self.children.get_mut(&parent) else { return };
            set.remove(&child);
            if set.is_empty() {
                self.children.remove(&parent);
            }
            child = parent;
        }
    }

    fn forget_identity(&mut self, path: &str, state: &State) {
        if let Some(id) = state.id {
            if self.identities.get(&id).map(String::as_str) == Some(path) {
                self.identities.remove(&id);
            }
        }
    }
}

/// Apply a completed operation to an index. The host does it right after it
/// announces a change, the syncing side once the host confirmed one: keeping
/// it in one place keeps the two sides' bookkeeping identical.
pub fn commit_op(index: &mut FileIndex, op: &SyncOp) {
    match op {
        SyncOp::Rename { from, to, state, .. } => {
            index.rekey(from, to);
            if let Some(state) = state {
                index.set(to, *state);
            }
        }
        SyncOp::Mkdir { path, state } | SyncOp::Write { path, state, .. } => {
            if let Some(state) = state {
                index.set(path, *state);
            }
        }
        SyncOp::Reindex { path, state } => index.set(path, *state),
        SyncOp::Unlink { path, .. } => index.delete(path),
        SyncOp::Rmdir { path } => index.delete_tree(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(id: u64) -> State {
        State { kind: Kind::File, size: 1, mtime_ms: 1, id: Some((1, id)) }
    }

    fn dir(id: u64) -> State {
        State { kind: Kind::Dir, size: 0, mtime_ms: 1, id: Some((1, id)) }
    }

    #[test]
    fn descendants_rekey_and_delete_tree() {
        let mut index = FileIndex::new();
        index.set("a", dir(1));
        index.set("a/b", dir(2));
        index.set("a/b/c.txt", file(3));
        index.set("x/y.txt", file(4)); // "x" is virtual
        let mut below: Vec<String> = index.descendants("a").into_iter().map(|(p, _)| p).collect();
        below.sort();
        assert_eq!(below, vec!["a/b", "a/b/c.txt"]);
        assert_eq!(index.descendants("x").len(), 1);
        assert_eq!(index.path_for_identity(Some((1, 3))), Some("a/b/c.txt"));

        index.rekey("a", "z");
        let mut keys: Vec<&String> = index.entries.keys().collect();
        keys.sort();
        assert_eq!(keys, vec!["x/y.txt", "z", "z/b", "z/b/c.txt"]);
        assert_eq!(index.path_for_identity(Some((1, 3))), Some("z/b/c.txt"));

        index.delete_tree("z");
        assert_eq!(index.len(), 1);
        index.delete("x/y.txt");
        assert!(index.children.is_empty(), "virtual parents are cleaned up");
    }

    #[test]
    fn scales_with_the_subtree() {
        let mut index = FileIndex::new();
        for d in 0..100 {
            index.set(&format!("d{d}"), dir(d));
            for f in 0..100 {
                index.set(&format!("d{d}/f{f}"), file(1000 + d * 100 + f));
            }
        }
        let started = std::time::Instant::now();
        for d in 0..100 {
            index.delete_tree(&format!("d{d}"));
        }
        assert!(index.is_empty());
        assert!(started.elapsed().as_millis() < 2000);
    }
}
