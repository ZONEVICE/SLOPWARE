//! The operations a change detector derives and a peer applies.

use crate::fs::entry::{Kind, State};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq)]
pub enum SyncOp {
    Mkdir {
        path: String,
        state: Option<State>,
    },
    /// A file was created or modified; `base` is the previous indexed state.
    Write {
        path: String,
        state: Option<State>,
        base: Option<State>,
    },
    Unlink {
        path: String,
        base: Option<State>,
    },
    /// A directory and everything below it.
    Rmdir {
        path: String,
    },
    Rename {
        from: String,
        to: String,
        kind: Kind,
        state: Option<State>,
        base: Option<State>,
    },
    /// Same content under a new inode: local bookkeeping, never sent.
    Reindex {
        path: String,
        state: State,
    },
}

impl SyncOp {
    pub fn name(&self) -> &'static str {
        match self {
            SyncOp::Mkdir { .. } => "mkdir",
            SyncOp::Write { .. } => "write",
            SyncOp::Unlink { .. } => "unlink",
            SyncOp::Rmdir { .. } => "rmdir",
            SyncOp::Rename { .. } => "rename",
            SyncOp::Reindex { .. } => "reindex",
        }
    }

    /// The path the operation is about (the source, for a rename).
    pub fn path(&self) -> &str {
        match self {
            SyncOp::Mkdir { path, .. }
            | SyncOp::Write { path, .. }
            | SyncOp::Unlink { path, .. }
            | SyncOp::Rmdir { path }
            | SyncOp::Reindex { path, .. } => path,
            SyncOp::Rename { from, .. } => from,
        }
    }

    /// The new local state the operation carries, if any.
    pub fn state(&self) -> Option<&State> {
        match self {
            SyncOp::Mkdir { state, .. } | SyncOp::Write { state, .. } | SyncOp::Rename { state, .. } => state.as_ref(),
            SyncOp::Reindex { state, .. } => Some(state),
            _ => None,
        }
    }

    /// Short description for logs and tests: `rename a -> b`, `write x`.
    pub fn summary(&self) -> String {
        match self {
            SyncOp::Rename { from, to, .. } => format!("rename {from} -> {to}"),
            other => format!("{} {}", other.name(), other.path()),
        }
    }

    /// The wire form announced on the host's stream: no inodes, no local-only
    /// fields, no base.
    pub fn to_wire(&self) -> Value {
        match self {
            SyncOp::Rename { from, to, kind, .. } => {
                json!({ "op": "rename", "from": from, "to": to, "kind": kind.as_str() })
            }
            SyncOp::Write { path, state, .. } => {
                let state = state.unwrap_or(State::file(0, 0));
                json!({ "op": "write", "path": path, "size": state.size, "mtimeMs": state.mtime_ms })
            }
            other => json!({ "op": other.name(), "path": other.path() }),
        }
    }
}
