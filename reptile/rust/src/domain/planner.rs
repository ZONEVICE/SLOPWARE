//! Three-way reconciliation planner.
//!
//! Pure function, no I/O. Given three snapshots of the synced tree:
//!
//!   local   what is on this machine's disk now,
//!   remote  what the host shares now (its manifest),
//!   base    what both sides had the last time they were known to agree,
//!
//! it decides, path by path, which side's version survives. The base is what
//! makes a deletion distinguishable from a creation. Without a base (the very
//! first connection) nothing is ever deleted: the two trees are merged.
//!
//! Rules, in order:
//!
//! ```text
//!   1. Both sides equal                   -> nothing to do (record the base).
//!   2. Only one side changed since base   -> that side wins.
//!   3. Both changed (or no base):
//!        one side absent                  -> the present side wins
//!                                            (a modification beats a deletion)
//!        both files                       -> the newer mtime wins; on a tie, the host
//!        file on one side, dir on other   -> conflict: left alone and reported
//! ```
//!
//! The same planner runs for the initial synchronisation, after every
//! reconnection, and whenever the live path meets something it cannot apply
//! safely, which is what makes the engine self-healing.

use crate::fs::entry::{same_state, Kind, State};
use crate::util::wire::{is_strictly_inside, parent_of, sort_paths};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ActionType {
    InSync,
    AdoptMtime,
    Forget,
    Download,
    LocalMkdir,
    LocalDelete,
    Upload,
    RemoteMkdir,
    RemoteDelete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Decision {
    None,
    Conflict,
    Act(ActionType),
}

#[derive(Clone, Debug)]
pub struct Action {
    pub kind: ActionType,
    pub path: String,
    pub local: Option<State>,
    pub remote: Option<State>,
    pub base: Option<State>,
}

#[derive(Clone, Debug)]
pub struct Conflict {
    pub path: String,
    pub local: Option<State>,
    pub remote: Option<State>,
}

pub struct Plan {
    pub actions: Vec<Action>,
    pub conflicts: Vec<Conflict>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Winner {
    Local,
    Remote,
    Equal,
    Conflict,
}

/// Which side wins when both changed.
fn resolve_both(local: Option<&State>, remote: Option<&State>) -> Winner {
    match (local, remote) {
        (None, _) => Winner::Remote,
        (_, None) => Winner::Local,
        (Some(l), Some(r)) if l.kind != r.kind => Winner::Conflict,
        (Some(l), Some(_)) if l.kind == Kind::Dir => Winner::Equal,
        (Some(l), Some(r)) => {
            if l.mtime_ms > r.mtime_ms {
                Winner::Local
            } else {
                Winner::Remote
            }
        }
    }
}

/// The action that makes the losing side look like the winning side.
fn action_for(winner: Winner, local: Option<&State>, remote: Option<&State>) -> ActionType {
    if winner == Winner::Remote {
        return match remote {
            None => ActionType::LocalDelete,
            Some(r) if r.kind == Kind::Dir => ActionType::LocalMkdir,
            Some(_) => ActionType::Download,
        };
    }
    match local {
        None => ActionType::RemoteDelete,
        Some(l) if l.kind == Kind::Dir => ActionType::RemoteMkdir,
        Some(_) => ActionType::Upload,
    }
}

/// Kind that will exist on each side once an action has been carried out.
fn final_kinds(decision: Decision, local: Option<&State>, remote: Option<&State>) -> (Option<Kind>, Option<Kind>) {
    let (l, r) = (local.map(|s| s.kind), remote.map(|s| s.kind));
    match decision {
        Decision::Act(ActionType::Forget) => (None, None),
        Decision::Act(ActionType::Download) => (Some(Kind::File), r),
        Decision::Act(ActionType::LocalMkdir) => (Some(Kind::Dir), r),
        Decision::Act(ActionType::LocalDelete) => (None, r),
        Decision::Act(ActionType::Upload) => (l, Some(Kind::File)),
        Decision::Act(ActionType::RemoteMkdir) => (l, Some(Kind::Dir)),
        Decision::Act(ActionType::RemoteDelete) => (l, None),
        _ => (l, r),
    }
}

struct Entry {
    decision: Decision,
    local: Option<State>,
    remote: Option<State>,
    base: Option<State>,
}

/// Plan a reconciliation. `is_rejected`: paths the host refuses to accept.
/// `equal_content`: files known (by hash) to be identical on both sides.
pub fn plan_sync(
    local: &HashMap<String, State>,
    remote: &HashMap<String, State>,
    base: &HashMap<String, State>,
    is_rejected: &dyn Fn(&str) -> bool,
    equal_content: &HashSet<String>,
) -> Plan {
    let mut all: HashSet<&String> = HashSet::new();
    all.extend(local.keys());
    all.extend(remote.keys());
    all.extend(base.keys());
    let sorted = sort_paths(all.into_iter().filter(|p| !p.is_empty()).cloned());

    let mut decisions: HashMap<&str, Entry> = HashMap::with_capacity(sorted.len());
    let mut blocked: Vec<&str> = Vec::new();

    for path in &sorted {
        let l = local.get(path).copied();
        let r = remote.get(path).copied();
        let b = base.get(path).copied();
        let mut entry = Entry { decision: Decision::None, local: l, remote: r, base: b };

        if blocked.iter().any(|prefix| is_strictly_inside(prefix, path)) {
            decisions.insert(path, entry);
            continue;
        }
        if same_state(l.as_ref(), r.as_ref()) {
            entry.decision = if l.is_some() {
                Decision::Act(ActionType::InSync)
            } else if b.is_some() {
                Decision::Act(ActionType::Forget)
            } else {
                Decision::None
            };
            decisions.insert(path, entry);
            continue;
        }
        if let (Some(ls), Some(rs)) = (l, r) {
            if ls.kind == Kind::File && rs.kind == Kind::File && ls.size == rs.size && equal_content.contains(path) {
                // Same bytes, different mtime: align the local mtime instead of copying.
                entry.decision = Decision::Act(ActionType::AdoptMtime);
                decisions.insert(path, entry);
                continue;
            }
        }
        let winner = match b {
            Some(base_state) => {
                let local_changed = !same_state(l.as_ref(), Some(&base_state));
                let remote_changed = !same_state(r.as_ref(), Some(&base_state));
                if !local_changed {
                    Winner::Remote
                } else if !remote_changed {
                    Winner::Local
                } else {
                    resolve_both(l.as_ref(), r.as_ref())
                }
            }
            None => resolve_both(l.as_ref(), r.as_ref()),
        };
        match winner {
            Winner::Equal => entry.decision = Decision::Act(ActionType::InSync),
            Winner::Conflict => {
                entry.decision = Decision::Conflict;
                blocked.push(path);
            }
            Winner::Local if r.is_none() && is_rejected(path) => {}
            _ => entry.decision = Decision::Act(action_for(winner, l.as_ref(), r.as_ref())),
        }
        decisions.insert(path, entry);
    }

    // --- Directory consistency ------------------------------------------------
    // A directory about to be deleted on one side while one of its children
    // must stay there is kept (and recreated on the other side instead); a
    // directory about to be replaced by a file while children must stay
    // becomes a conflict.
    let reconcile_directories = |decisions: &mut HashMap<&str, Entry>| {
        let mut local_children: HashSet<String> = HashSet::new();
        let mut remote_children: HashSet<String> = HashSet::new();
        for path in sorted.iter().rev() {
            let entry = decisions.get_mut(path.as_str()).unwrap();
            let has_local_child = local_children.contains(path);
            let has_remote_child = remote_children.contains(path);
            let local_dir = entry.local.map(|s| s.kind) == Some(Kind::Dir);
            let remote_dir = entry.remote.map(|s| s.kind) == Some(Kind::Dir);
            match entry.decision {
                Decision::Act(ActionType::LocalDelete) if local_dir && has_local_child => {
                    entry.decision = Decision::Act(if entry.remote.is_some() {
                        ActionType::InSync
                    } else {
                        ActionType::RemoteMkdir
                    });
                }
                Decision::Act(ActionType::RemoteDelete) if remote_dir && has_remote_child => {
                    entry.decision =
                        Decision::Act(if entry.local.is_some() { ActionType::InSync } else { ActionType::LocalMkdir });
                }
                Decision::Act(ActionType::Download) if local_dir && has_local_child => {
                    entry.decision = Decision::Conflict
                }
                Decision::Act(ActionType::Upload) if remote_dir && has_remote_child => {
                    entry.decision = Decision::Conflict
                }
                _ => {}
            }
            let (final_local, final_remote) = final_kinds(entry.decision, entry.local.as_ref(), entry.remote.as_ref());
            let parent = parent_of(path);
            if !parent.is_empty() {
                if final_local.is_some() {
                    local_children.insert(parent.to_string());
                }
                if final_remote.is_some() {
                    remote_children.insert(parent.to_string());
                }
            }
        }
    };
    reconcile_directories(&mut decisions);

    // A conflict freezes everything below it.
    let conflict_paths: Vec<String> =
        sorted.iter().filter(|path| decisions[path.as_str()].decision == Decision::Conflict).cloned().collect();
    if !conflict_paths.is_empty() {
        for path in &sorted {
            if conflict_paths.iter().any(|prefix| is_strictly_inside(prefix, path)) {
                decisions.get_mut(path.as_str()).unwrap().decision = Decision::None;
            }
        }
        reconcile_directories(&mut decisions);
    }

    let mut actions = Vec::new();
    let mut conflicts = Vec::new();
    for path in &sorted {
        let entry = &decisions[path.as_str()];
        match entry.decision {
            Decision::None => {}
            Decision::Conflict => {
                conflicts.push(Conflict { path: path.clone(), local: entry.local, remote: entry.remote })
            }
            Decision::Act(kind) => actions.push(Action {
                kind,
                path: path.clone(),
                local: entry.local,
                remote: entry.remote,
                base: entry.base,
            }),
        }
    }
    Plan { actions, conflicts }
}

/// Files whose content equality would change the plan: same size on both
/// sides, different mtime, and no base that already explains the difference.
pub fn hash_candidates(
    local: &HashMap<String, State>,
    remote: &HashMap<String, State>,
    base: &HashMap<String, State>,
) -> Vec<String> {
    let mut out = Vec::new();
    for (path, l) in local {
        let Some(r) = remote.get(path) else { continue };
        if l.kind != Kind::File || r.kind != Kind::File || l.size != r.size || l.mtime_ms == r.mtime_ms {
            continue;
        }
        if let Some(b) = base.get(path) {
            // With a base and exactly one side changed, the plan is already clear.
            if same_state(Some(l), Some(b)) || same_state(Some(r), Some(b)) {
                continue;
            }
        }
        out.push(path.clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(size: u64, mtime: i64) -> State {
        State::file(size, mtime)
    }

    fn d() -> State {
        State::dir(1)
    }

    fn map(entries: &[(&str, State)]) -> HashMap<String, State> {
        entries.iter().map(|(p, s)| (p.to_string(), *s)).collect()
    }

    fn plan(local: &[(&str, State)], remote: &[(&str, State)], base: &[(&str, State)]) -> Vec<(String, ActionType)> {
        let result = plan_sync(&map(local), &map(remote), &map(base), &|_| false, &HashSet::new());
        result.actions.into_iter().map(|a| (a.path, a.kind)).collect()
    }

    fn has(actions: &[(String, ActionType)], path: &str, kind: ActionType) -> bool {
        actions.iter().any(|(p, k)| p == path && *k == kind)
    }

    #[test]
    fn first_sync_merges_without_deleting() {
        let actions = plan(&[("mine.txt", f(1, 1))], &[("theirs.txt", f(1, 1))], &[]);
        assert!(has(&actions, "mine.txt", ActionType::Upload));
        assert!(has(&actions, "theirs.txt", ActionType::Download));
    }

    #[test]
    fn one_side_changed_wins() {
        let base = [("a.txt", f(1, 1))];
        let actions = plan(&[("a.txt", f(1, 1))], &[("a.txt", f(2, 2))], &base);
        assert!(has(&actions, "a.txt", ActionType::Download));
        let actions = plan(&[("a.txt", f(2, 2))], &[("a.txt", f(1, 1))], &base);
        assert!(has(&actions, "a.txt", ActionType::Upload));
        let actions = plan(&[], &[("a.txt", f(1, 1))], &base);
        assert!(has(&actions, "a.txt", ActionType::RemoteDelete));
        let actions = plan(&[("a.txt", f(1, 1))], &[], &base);
        assert!(has(&actions, "a.txt", ActionType::LocalDelete));
    }

    #[test]
    fn both_changed_newer_wins_and_modification_beats_deletion() {
        let base = [("a.txt", f(1, 1))];
        let actions = plan(&[("a.txt", f(2, 5))], &[("a.txt", f(3, 4))], &base);
        assert!(has(&actions, "a.txt", ActionType::Upload));
        let actions = plan(&[("a.txt", f(2, 4))], &[("a.txt", f(3, 4))], &base);
        assert!(has(&actions, "a.txt", ActionType::Download), "a tie goes to the host");
        let actions = plan(&[("a.txt", f(2, 5))], &[], &base);
        assert!(has(&actions, "a.txt", ActionType::Upload));
    }

    #[test]
    fn file_versus_directory_is_a_conflict_that_freezes_below() {
        let result = plan_sync(
            &map(&[("x", f(1, 1))]),
            &map(&[("x", d()), ("x/inner.txt", f(1, 1))]),
            &HashMap::new(),
            &|_| false,
            &HashSet::new(),
        );
        assert_eq!(result.conflicts.len(), 1);
        assert!(result.actions.iter().all(|a| a.path != "x/inner.txt"));
    }

    #[test]
    fn a_directory_with_surviving_children_is_kept() {
        let base = [("dir", d()), ("dir/old.txt", f(1, 1))];
        // Deleted remotely, but a new local file lives inside: keep and recreate.
        let actions = plan(&[("dir", d()), ("dir/old.txt", f(1, 1)), ("dir/new.txt", f(1, 2))], &[], &base);
        assert!(has(&actions, "dir", ActionType::RemoteMkdir));
        assert!(has(&actions, "dir/new.txt", ActionType::Upload));
        assert!(has(&actions, "dir/old.txt", ActionType::LocalDelete));
    }

    #[test]
    fn equal_content_adopts_the_mtime_and_rejected_paths_are_not_uploaded() {
        let equal: HashSet<String> = ["a.txt".to_string()].into();
        let result =
            plan_sync(&map(&[("a.txt", f(3, 1))]), &map(&[("a.txt", f(3, 2))]), &HashMap::new(), &|_| false, &equal);
        assert_eq!(result.actions[0].kind, ActionType::AdoptMtime);
        let result = plan_sync(
            &map(&[("no.txt", f(1, 1))]),
            &HashMap::new(),
            &HashMap::new(),
            &|p| p == "no.txt",
            &HashSet::new(),
        );
        assert!(result.actions.is_empty());
        let candidates = hash_candidates(&map(&[("a", f(3, 1))]), &map(&[("a", f(3, 2))]), &HashMap::new());
        assert_eq!(candidates, vec!["a"]);
    }
}
