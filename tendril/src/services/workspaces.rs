//! Which workspaces each session opened.
//!
//! A workspace is bound to the session on the server: the browser holds only
//! an opaque id (`X-Tendril-Workspace` header or `ws` query parameter) that is
//! meaningless for any other session. Several ids per session let two browser
//! tabs work on different folders without stepping on each other. Opening the
//! same folder twice returns the same id.
//!
//! The registry also keeps the recently opened folders in
//! `~/.tendril/recent.json` for the picker.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::auth::SessionId;
use super::files::FsResult;
use super::files::jail::Jail;
use crate::core::clock;
use crate::core::jsonfile;
use crate::core::lock::LockExt;
use crate::core::random;

/// Workspaces one session may hold open; the oldest is forgotten beyond it.
pub const MAX_PER_SESSION: usize = 16;
/// Entries kept in `recent.json`.
pub const MAX_RECENT: usize = 12;

/// An open workspace.
pub struct Workspace {
    pub id: String,
    pub jail: Arc<Jail>,
}

/// A recently opened folder.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Recent {
    pub path: String,
    pub opened: u64,
}

/// The workspaces of one session: (id, jail), oldest first.
type SessionWorkspaces = Vec<(String, Arc<Jail>)>;

/// Per-session workspace registry plus the recent list.
pub struct Workspaces {
    open: Mutex<HashMap<SessionId, SessionWorkspaces>>,
    recent_file: PathBuf,
    recent: Mutex<Vec<Recent>>,
}

impl Workspaces {
    /// A registry persisting recent folders in `recent_file`.
    pub fn new(recent_file: &Path) -> Workspaces {
        let recent = jsonfile::read::<Vec<Recent>>(recent_file).ok().flatten().unwrap_or_default();
        Workspaces {
            open: Mutex::new(HashMap::new()),
            recent_file: recent_file.to_path_buf(),
            recent: Mutex::new(recent),
        }
    }

    /// Opens `path` for `session` and returns its id and jail.
    pub fn open(&self, session: SessionId, path: &Path) -> FsResult<Workspace> {
        let jail = Arc::new(Jail::new(path)?);
        let id = {
            let mut open = self.open.locked();
            let list = open.entry(session).or_default();
            if let Some((id, existing)) = list.iter().find(|(_, j)| j.root() == jail.root()) {
                let workspace = Workspace { id: id.clone(), jail: existing.clone() };
                drop(open);
                self.remember(&workspace.jail);
                return Ok(workspace);
            }
            if list.len() >= MAX_PER_SESSION {
                list.remove(0);
            }
            let id = random::token_hex(8);
            list.push((id.clone(), jail.clone()));
            id
        };
        self.remember(&jail);
        Ok(Workspace { id, jail })
    }

    /// The workspace `id` of `session`, if it exists.
    pub fn get(&self, session: SessionId, id: &str) -> Option<Arc<Jail>> {
        self.open.locked().get(&session)?.iter().find(|(i, _)| i == id).map(|(_, j)| j.clone())
    }

    /// Forgets every workspace of a session (logout).
    pub fn drop_session(&self, session: SessionId) {
        self.open.locked().remove(&session);
    }

    /// Recently opened folders, most recent first, that still exist.
    pub fn recent(&self) -> Vec<Recent> {
        self.recent.locked().iter().filter(|r| Path::new(&r.path).is_dir()).cloned().collect()
    }

    fn remember(&self, jail: &Jail) {
        let path = jail.display_root();
        let mut recent = self.recent.locked();
        recent.retain(|r| r.path != path);
        recent.insert(0, Recent { path, opened: clock::unix_ms() });
        recent.truncate(MAX_RECENT);
        let _ = jsonfile::write(&self.recent_file, &*recent, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_per_session_and_stable() {
        let base = std::env::temp_dir().join(format!("tendril-ws-{}", random::token_hex(4)));
        std::fs::create_dir_all(base.join("a")).unwrap();
        std::fs::create_dir_all(base.join("b")).unwrap();
        let registry = Workspaces::new(&base.join("recent.json"));
        let s1 = SessionId([1; 16]);
        let s2 = SessionId([2; 16]);
        let a = registry.open(s1, &base.join("a")).unwrap();
        let again = registry.open(s1, &base.join("a")).unwrap();
        assert_eq!(a.id, again.id);
        let b = registry.open(s1, &base.join("b")).unwrap();
        assert_ne!(a.id, b.id);
        assert!(registry.get(s1, &a.id).is_some());
        // Another session cannot use the id.
        assert!(registry.get(s2, &a.id).is_none());
        registry.drop_session(s1);
        assert!(registry.get(s1, &a.id).is_none());
        // The recent list survives a restart.
        let reloaded = Workspaces::new(&base.join("recent.json"));
        let recent = reloaded.recent();
        assert_eq!(recent.len(), 2);
        assert!(recent[0].path.ends_with('b'));
        assert!(registry.open(s1, &base.join("missing")).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
}
