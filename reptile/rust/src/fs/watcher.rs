//! Filesystem watcher and change detector.
//!
//! The operating system reports that something happened to a path
//! (`fs::os_watch`). Those notifications cannot be forwarded to a peer as they
//! are: there is no portable rename event (renaming "a" to "b" arrives as two
//! unrelated notifications), and a change applied on behalf of the peer
//! produces notifications too, which would bounce back forever.
//!
//! So notifications are only hints about WHICH paths to look at. Each batch
//! compares what is on disk now with the index (the state last known to be in
//! sync) and derives operations from the difference:
//!
//!   disk has it, index does not          -> mkdir / write
//!   index has it, disk does not          -> unlink / rmdir (held back briefly)
//!   file on both, size or mtime differs  -> write
//!   a new path holds the inode of a path
//!   that is gone                          -> rename (a directory's children
//!                                            move with it)
//!
//! Echo suppression falls out of this for free: whoever applies a peer's change
//! updates the index first, so the resulting notifications find nothing new.
//!
//! Removals are held for `rename_window_ms` before being reported, because the
//! other half of a rename may still be on its way.
//!
//! Nothing here trusts a single notification to arrive. Four hints together
//! make detection complete:
//!   1. every notification touches the path it names (or, when the platform
//!      gives no name, every entry of the directory it came from);
//!   2. a new or renamed directory, and any directory that just got its own
//!      watch, is walked, so files created inside it before the watch existed
//!      are examined too;
//!   3. a file modified in the last `stability_ms` is re-examined later rather
//!      than sent half-written;
//!   4. every `rescan_interval_ms` the whole tree is compared with the index.
//!
//! Threads: the OS watcher thread sends hints over a channel to this
//! watcher's thread, which debounces them and runs each batch through the
//! owner (`WatchOwner::batch`), which holds its own lock for the duration.
//! Lock order: owner lock, then this watcher's `core`. `touch` and `rescan`
//! may be called from any thread and never take the owner's batch lock.

use crate::fs::entry::{read_dir_states, read_state_lossy, same_state, Kind, State};
use crate::fs::index::FileIndex;
use crate::fs::ops::SyncOp;
use crate::fs::os_watch::{vanished, Hint, OsWatch, NOTIFICATIONS};
use crate::util::logger::Logger;
use crate::util::threads::Locked;
use crate::util::time::now_ms;
use crate::util::wire::{depth_of, is_strictly_inside, join, rebase, resolve, sort_paths};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Copy, Debug)]
pub struct WatcherTiming {
    /// Wait this long after the last notification...
    pub quiet_ms: i64,
    /// ...but never longer than this after the first one.
    pub max_wait_ms: i64,
    /// How long a removal is held back.
    pub rename_window_ms: i64,
    /// A written file must stay unchanged this long.
    pub stability_ms: i64,
    /// Full comparison period; 0 disables it.
    pub rescan_interval_ms: i64,
}

impl Default for WatcherTiming {
    fn default() -> Self {
        WatcherTiming {
            quiet_ms: 150,
            max_wait_ms: 1000,
            rename_window_ms: 1200,
            stability_ms: 300,
            rescan_interval_ms: 5 * 60_000,
        }
    }
}

/// What a batch may consult and do while the owner's lock is held.
pub trait BatchHooks {
    /// Paths that must never be reported.
    fn ignore(&self, wire: &str) -> bool;
    /// Directories whose content must not even be watched.
    fn ignore_inside(&self, wire: &str) -> bool;
    /// Called for every path found on disk where the index does not have it
    /// (or has another inode), before anything inside it is examined.
    fn raw_add(&mut self, _wire: &str, _state: &State) {}
}

/// Snapshot of the owner's filters, for walks done without its lock.
pub struct Filters {
    pub ignore: Box<dyn Fn(&str) -> bool + Send>,
    pub ignore_inside: Box<dyn Fn(&str) -> bool + Send>,
}

/// The service a watcher reports to (the hosting share or the syncing engine).
pub trait WatchOwner: Send + Sync + 'static {
    /// Run one batch with exclusive access to the owner's state: call `diff`
    /// with the index and hooks, then deliver the operations it returns.
    fn batch(&self, diff: &mut dyn FnMut(&FileIndex, &mut dyn BatchHooks) -> Vec<SyncOp>);
    /// Short read-only look at the index (must not wait for `batch`'s lock).
    fn inspect(&self, look: &mut dyn FnMut(&FileIndex));
    fn filters(&self) -> Filters;
    /// The watched directory vanished. Never read as "everything was deleted".
    fn root_missing(&self);
    /// Watching failed in a way the user should know about.
    fn report_error(&self, message: String);
}

enum Message {
    Hint(Hint),
    Wake,
    Flush(Sender<()>),
    Close,
}

#[derive(Default)]
struct Core {
    touched: HashSet<String>,
    /// Wire path -> when it was first seen missing.
    pending_removals: HashMap<String, i64>,
    /// How many times a still-changing file was put off.
    deferrals: HashMap<String, u32>,
    first_touch_at: i64,
    last_touch_at: i64,
    next_removal_due: i64,
    next_retry_due: i64,
    last_rescan_at: i64,
}

struct Shared {
    root: PathBuf,
    owner: Arc<dyn WatchOwner>,
    tree: OsWatch,
    timing: WatcherTiming,
    core: Mutex<Core>,
    sender: Mutex<Sender<Message>>,
    closed: AtomicBool,
    logger: Logger,
}

/// A running watcher. `close` stops it; dropping it does too.
pub struct Watcher {
    shared: Arc<Shared>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Watcher {
    /// Watch `root`. Returns once every directory is watched, so the owner can
    /// build its index knowing nothing will be missed.
    pub fn start(
        root: &Path,
        owner: Arc<dyn WatchOwner>,
        timing: WatcherTiming,
        logger: Logger,
    ) -> std::io::Result<Watcher> {
        let (sender, receiver) = channel::<Message>();
        let (hint_sender, hint_receiver) = channel::<Hint>();
        let filters = owner.filters();
        let (tree, errors) = OsWatch::start(root, &|dir| !(filters.ignore_inside)(dir), hint_sender)?;
        for error in errors.iter().filter(|e| !vanished(e)) {
            logger.warn(format_args!("watcher error: {error}"));
            owner.report_error(watch_error_message(error));
        }
        let shared = Arc::new(Shared {
            root: root.to_path_buf(),
            owner,
            tree,
            timing,
            core: Mutex::new(Core { last_rescan_at: now_ms(), ..Default::default() }),
            sender: Mutex::new(sender.clone()),
            closed: AtomicBool::new(false),
            logger,
        });
        // Forward OS hints into the watcher's own channel.
        std::thread::Builder::new().name("watch-hints".into()).spawn(move || {
            for hint in hint_receiver {
                if sender.send(Message::Hint(hint)).is_err() {
                    return;
                }
            }
        })?;
        let worker = shared.clone();
        let thread = std::thread::Builder::new().name("watcher".into()).spawn(move || worker.run(receiver))?;
        Ok(Watcher { shared, thread: Mutex::new(Some(thread)) })
    }

    /// Force a path to be re-examined in the next batch.
    pub fn touch(&self, wire: &str) {
        self.shared.touch(wire);
    }

    /// Compare the whole tree with the index now and touch every difference.
    /// Safe to call while holding the owner's batch lock.
    pub fn rescan(&self) -> usize {
        self.shared.rescan()
    }

    /// Process whatever is pending right now; returns when that batch is done.
    pub fn flush(&self) {
        let (done, wait) = channel();
        if self.shared.send(Message::Flush(done)) {
            let _ = wait.recv_timeout(Duration::from_secs(30));
        }
    }

    /// Paths waiting to be examined, plus removals being held back.
    pub fn pending(&self) -> usize {
        let core = self.shared.core.locked();
        core.touched.len() + core.pending_removals.len()
    }

    /// How many OS watches are open (one per directory, or one when recursive).
    pub fn watching(&self) -> usize {
        self.shared.tree.size()
    }

    pub fn recursive(&self) -> bool {
        self.shared.tree.recursive()
    }

    /// Stop watching. Safe to call twice, from any thread, even while the
    /// owner's batch lock is held: the watcher's own thread is told to stop
    /// and left to finish on its own (a batch it already started sees the
    /// owner stopped and does nothing), so closing never waits for it.
    pub fn close(&self) {
        if self.shared.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.shared.send(Message::Close);
        self.shared.tree.close();
        self.thread.locked().take();
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.close();
    }
}

fn watch_error_message(error: &std::io::Error) -> String {
    if error.raw_os_error() == Some(28) || error.kind() == std::io::ErrorKind::StorageFull {
        "The system limit of watched directories was reached; some changes may not be detected.".into()
    } else {
        error.to_string()
    }
}

/// A copy-on-write view over the index. A batch applies the renames and
/// additions it detects to the view, so later paths in the same batch are
/// compared against the state the peer will have after those operations,
/// while the real index only changes once the owner commits.
struct Overlay<'a> {
    index: &'a FileIndex,
    map: HashMap<String, Option<State>>,
}

impl<'a> Overlay<'a> {
    fn get(&self, path: &str) -> Option<State> {
        match self.map.get(path) {
            Some(value) => *value,
            None => self.index.get(path).copied(),
        }
    }

    fn set(&mut self, path: &str, state: Option<State>) {
        self.map.insert(path.to_string(), state);
    }

    fn descendants(&self, path: &str) -> HashMap<String, State> {
        let mut out: HashMap<String, State> =
            self.index.descendants(path).into_iter().filter(|(child, _)| !self.map.contains_key(child)).collect();
        for (child, state) in &self.map {
            if let Some(state) = state {
                if is_strictly_inside(path, child) {
                    out.insert(child.clone(), *state);
                }
            }
        }
        out
    }

    fn delete_tree(&mut self, path: &str) {
        for child in self.descendants(path).into_keys() {
            self.map.insert(child, None);
        }
        self.map.insert(path.to_string(), None);
    }

    fn rekey(&mut self, from: &str, to: &str) {
        let mut moving: Vec<(String, State)> = Vec::new();
        if let Some(own) = self.get(from) {
            moving.push((from.to_string(), own));
        }
        moving.extend(self.descendants(from));
        for (path, _) in &moving {
            self.map.insert(path.clone(), None);
        }
        self.delete_tree(to);
        for (path, state) in moving {
            self.map.insert(rebase(&path, from, to), Some(state));
        }
    }
}

/// Everything one batch reads and accumulates.
struct Batch<'a> {
    root: &'a Path,
    tree: &'a OsWatch,
    index: &'a FileIndex,
    hooks: &'a mut dyn BatchHooks,
    disk: HashMap<String, Option<State>>,
    candidates: HashSet<String>,
    expanded: HashSet<String>,
}

impl Batch<'_> {
    fn visible(&self, wire: &str) -> bool {
        !wire.is_empty() && !self.hooks.ignore(wire)
    }

    fn record(&mut self, path: &str, state: Option<State>) -> Option<State> {
        let state = state.filter(|s| s.is_syncable());
        self.disk.insert(path.to_string(), state);
        if let Some(found) = state {
            let known = self.index.get(path);
            if known.is_none() || known.and_then(|k| k.id) != found.id {
                self.hooks.raw_add(path, &found);
            }
        }
        state
    }

    fn look(&mut self, path: &str) -> Option<State> {
        if let Some(cached) = self.disk.get(path) {
            return *cached;
        }
        let state = if self.hooks.ignore(path) {
            None
        } else {
            resolve(self.root, path).ok().and_then(|p| read_state_lossy(&p))
        };
        self.record(path, state)
    }

    /// Hint 2: add everything below a directory as candidates. Watch first,
    /// list second: nothing created in between is missed.
    fn expand(&mut self, directory: &str) {
        if !self.expanded.insert(directory.to_string()) {
            return;
        }
        let mut stack = vec![directory.to_string()];
        while let Some(current) = stack.pop() {
            if !self.tree.recursive() && !self.hooks.ignore_inside(&current) {
                let _ = self.tree.add(&current);
            }
            let Ok(path) = resolve(self.root, &current) else { continue };
            let Ok(listing) = read_dir_states(&path) else { continue };
            for (name, state) in listing {
                let child = join(&current, &name);
                if !self.visible(&child) {
                    continue;
                }
                self.candidates.insert(child.clone());
                let state = match self.disk.get(&child) {
                    Some(cached) => *cached,
                    None => self.record(&child, Some(state)),
                };
                if state.map(|s| s.kind) == Some(Kind::Dir) {
                    stack.push(child);
                }
            }
        }
    }
}

impl Shared {
    fn send(&self, message: Message) -> bool {
        self.sender.locked().send(message).is_ok()
    }

    fn touch(&self, wire: &str) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut core = self.core.locked();
            let now = now_ms();
            core.touched.insert(wire.to_string());
            if core.first_touch_at == 0 {
                core.first_touch_at = now;
            }
            core.last_touch_at = now;
        }
        self.send(Message::Wake);
    }

    /// When the next batch is due, in epoch milliseconds (None: nothing to do).
    fn due(&self) -> Option<i64> {
        let core = self.core.locked();
        let mut due: Option<i64> = None;
        let mut consider = |candidate: i64| due = Some(due.map_or(candidate, |d: i64| d.min(candidate)));
        // Paths put back for a retry carry no touch time: they wait for
        // `next_retry_due` instead of firing again at once.
        if !core.touched.is_empty() && core.first_touch_at > 0 {
            consider((core.last_touch_at + self.timing.quiet_ms).min(core.first_touch_at + self.timing.max_wait_ms));
        }
        if !core.pending_removals.is_empty() && core.next_removal_due > 0 {
            consider(core.next_removal_due);
        }
        if core.next_retry_due > 0 {
            consider(core.next_retry_due);
        }
        let rescan_every = self.rescan_interval();
        if rescan_every > 0 {
            consider(core.last_rescan_at + rescan_every);
        }
        due
    }

    fn rescan_interval(&self) -> i64 {
        // Without notifications, frequent rescans are the only detection.
        if NOTIFICATIONS {
            self.timing.rescan_interval_ms
        } else {
            2000
        }
    }

    fn run(self: Arc<Self>, receiver: Receiver<Message>) {
        loop {
            if self.closed.load(Ordering::SeqCst) {
                return;
            }
            let now = now_ms();
            let wait = match self.due() {
                Some(due) if due <= now => Duration::ZERO,
                Some(due) => Duration::from_millis((due - now) as u64),
                None => Duration::from_secs(3600),
            };
            let message = if wait.is_zero() {
                receiver.try_recv().map_err(|_| RecvTimeoutError::Timeout)
            } else {
                receiver.recv_timeout(wait)
            };
            match message {
                Ok(Message::Hint(hint)) => self.on_hint(hint),
                Ok(Message::Wake) => {}
                Ok(Message::Flush(done)) => {
                    self.fire();
                    let _ = done.send(());
                }
                Ok(Message::Close) | Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) => self.on_timer(),
            }
        }
    }

    fn on_hint(&self, hint: Hint) {
        match hint {
            Hint::Path(wire) => self.touch(&wire),
            Hint::Directory(dir) => self.touch_children(&dir),
            Hint::Overflow => {
                self.logger.debug("the kernel dropped notifications; comparing everything");
                self.rescan();
            }
        }
    }

    fn on_timer(&self) {
        let rescan_every = self.rescan_interval();
        let rescan_due = {
            let core = self.core.locked();
            rescan_every > 0 && now_ms() >= core.last_rescan_at + rescan_every
        };
        if rescan_due {
            let differences = self.rescan();
            if differences > 0 {
                self.logger.debug(format_args!("rescan found {differences} difference(s)"));
            }
        }
        let batch_due = {
            let core = self.core.locked();
            let now = now_ms();
            (!core.touched.is_empty()
                && core.first_touch_at > 0
                && now
                    >= (core.last_touch_at + self.timing.quiet_ms).min(core.first_touch_at + self.timing.max_wait_ms))
                || (core.next_removal_due > 0 && !core.pending_removals.is_empty() && now >= core.next_removal_due)
                || (core.next_retry_due > 0 && now >= core.next_retry_due)
        };
        if batch_due {
            self.fire();
        }
    }

    /// Hint 1, for notifications that do not say which entry changed.
    fn touch_children(&self, dir: &str) {
        let mut paths = Vec::new();
        if !dir.is_empty() {
            paths.push(dir.to_string());
        }
        // What the index holds there, for deletions...
        self.owner.inspect(&mut |index| paths.extend(index.children_of(dir)));
        // ...plus what the disk holds.
        let path = match resolve(&self.root, dir) {
            Ok(path) => path,
            Err(_) => return,
        };
        match std::fs::read_dir(&path) {
            Ok(listing) => {
                for entry in listing.filter_map(Result::ok) {
                    paths.push(join(dir, &entry.file_name().to_string_lossy()));
                }
            }
            Err(_) if dir.is_empty() => {
                // The root itself may be what went away; never wait for a
                // batch to notice when the index is empty.
                if read_state_lossy(&self.root).map(|s| s.kind) != Some(Kind::Dir)
                    && !self.closed.load(Ordering::SeqCst)
                {
                    self.owner.root_missing();
                }
                return;
            }
            Err(_) => {}
        }
        for path in paths {
            if !crate::fs::entry::is_temp_path(&path) {
                self.touch(&path);
            }
        }
    }

    /// Compare the whole tree with the index and touch every difference.
    fn rescan(&self) -> usize {
        if self.closed.load(Ordering::SeqCst) {
            return 0;
        }
        self.core.locked().last_rescan_at = now_ms();
        let filters = self.owner.filters();
        let visible = |wire: &str| !wire.is_empty() && !(filters.ignore)(wire);
        let mut seen: HashMap<String, State> = HashMap::new();
        let mut directories: HashSet<String> = HashSet::new();
        let mut stack = vec![String::new()];
        while let Some(directory) = stack.pop() {
            // Repair the watch set as well: a directory whose watch could not
            // be created (the watch limit) gets another chance.
            if !self.tree.recursive() && (directory.is_empty() || !(filters.ignore_inside)(&directory)) {
                let _ = self.tree.add(&directory);
            }
            directories.insert(directory.clone());
            let Ok(path) = resolve(&self.root, &directory) else { continue };
            let Ok(listing) = read_dir_states(&path) else { continue };
            for (name, state) in listing {
                let wire = join(&directory, &name);
                if !visible(&wire) || !state.is_syncable() {
                    continue;
                }
                if state.kind == Kind::Dir {
                    stack.push(wire.clone());
                }
                seen.insert(wire, state);
            }
        }
        if !self.closed.load(Ordering::SeqCst) {
            self.tree.retain(&directories);
        }
        let mut differences = Vec::new();
        self.owner.inspect(&mut |index| {
            for (wire, state) in &seen {
                if !same_state(index.get(wire), Some(state)) {
                    differences.push(wire.clone());
                }
            }
            for (wire, _) in index.iter() {
                if !seen.contains_key(wire) && visible(wire) {
                    differences.push(wire.clone());
                }
            }
        });
        let count = differences.len();
        for wire in differences {
            self.touch(&wire);
        }
        count
    }

    fn fire(&self) {
        let mut root_missing = false;
        let mut ran = false;
        self.owner.batch(&mut |index, hooks| {
            ran = true;
            let mut core = self.core.locked();
            let (ops, missing) = self.process(&mut core, index, hooks);
            root_missing = missing;
            ops
        });
        if !ran {
            // The owner is gone or busy shutting down: forget the work.
            let mut core = self.core.locked();
            core.touched.clear();
            core.first_touch_at = 0;
            core.next_retry_due = 0;
        }
        if root_missing && !self.closed.load(Ordering::SeqCst) {
            self.owner.root_missing();
        }
    }

    fn process(&self, core: &mut Core, index: &FileIndex, hooks: &mut dyn BatchHooks) -> (Vec<SyncOp>, bool) {
        if self.closed.load(Ordering::SeqCst) {
            return (Vec::new(), false);
        }
        let started = now_ms();
        let mut batch = Batch {
            root: &self.root,
            tree: &self.tree,
            index,
            hooks,
            disk: HashMap::new(),
            candidates: std::mem::take(&mut core.touched),
            expanded: HashSet::new(),
        };
        core.first_touch_at = 0;
        core.last_touch_at = 0;
        core.next_retry_due = 0;
        batch.candidates.extend(core.pending_removals.keys().cloned());
        if batch.candidates.is_empty() {
            return (Vec::new(), false);
        }

        // A vanished root (deleted, or a drive unmounted) must never be read as
        // "every file was deleted": that would wipe the peer's copy too.
        if read_state_lossy(&self.root).map(|s| s.kind) != Some(Kind::Dir) {
            core.pending_removals.clear();
            return (Vec::new(), true);
        }

        let initial: Vec<String> = batch.candidates.iter().cloned().collect();
        for path in &initial {
            batch.look(path);
        }

        // A directory that vanished (or turned into a file) takes its indexed
        // descendants with it, whether or not each of them was reported.
        for path in batch.candidates.iter().cloned().collect::<Vec<_>>() {
            let was_dir = index.get(&path).map(|s| s.kind) == Some(Kind::Dir);
            let is_dir = batch.disk.get(&path).copied().flatten().map(|s| s.kind) == Some(Kind::Dir);
            if was_dir && !is_dir {
                for (child, _) in index.descendants(&path) {
                    if batch.candidates.insert(child.clone()) {
                        batch.disk.insert(child, None);
                    }
                }
            }
        }

        // A directory that just got its own watch may already hold entries
        // created before the watch existed: look inside it (hint 2). This also
        // covers directories the owner created itself and recorded in the
        // index first, which therefore never show up as new below.
        if !self.tree.recursive() {
            for path in batch.candidates.iter().cloned().collect::<Vec<_>>() {
                let is_dir = batch.disk.get(&path).copied().flatten().map(|s| s.kind) == Some(Kind::Dir);
                if is_dir
                    && !self.tree.has(&path)
                    && !batch.hooks.ignore_inside(&path)
                    && self.tree.add(&path).unwrap_or(false)
                {
                    batch.expanded.remove(&path);
                    batch.expand(&path);
                }
            }
        }

        let mut view = Overlay { index, map: HashMap::new() };
        let mut renames: Vec<SyncOp> = Vec::new();

        // --- Phase A: renames, recognised by device + inode ---------------------
        // Parents first, so that a renamed directory is found before its
        // children, which then compare equal in the view.
        for path in sort_paths(batch.candidates.iter().cloned()) {
            let Some(now) = batch.disk.get(&path).copied().flatten() else { continue };
            let Some(key) = now.id else { continue };
            if view.get(&path).and_then(|k| k.id) == Some(key) {
                continue;
            }
            let Some(from) = index.path_for_identity(Some(key)).map(str::to_string) else { continue };
            if from == path {
                continue;
            }
            let Some(previous) = view.get(&from) else { continue };
            if previous.id != Some(key) || previous.kind != now.kind {
                continue;
            }
            if now.kind == Kind::File && (previous.size != now.size || previous.mtime_ms != now.mtime_ms) {
                continue;
            }
            // A hard link keeps both names alive; that is an addition, not a move.
            if batch.look(&from).and_then(|s| s.id) == Some(key) {
                continue;
            }
            renames.push(SyncOp::Rename {
                from: from.clone(),
                to: path.clone(),
                kind: now.kind,
                state: Some(now),
                base: None,
            });
            view.rekey(&from, &path);
            view.set(&path, Some(now));
            core.pending_removals.remove(&from);
            // Something new may already live at the old location.
            batch.candidates.insert(from.clone());
            if now.kind == Kind::Dir {
                // The children moved along. Check each at its new location so a
                // file changed, deleted or added during the move is noticed.
                let children: Vec<String> = view.descendants(&path).into_keys().collect();
                for child in &children {
                    batch.candidates.insert(child.clone());
                    batch.look(child);
                }
                batch.expand(&path);
            }
        }

        // New directories, including one that replaced a file: examine their
        // content too (hint 2).
        for path in batch.candidates.iter().cloned().collect::<Vec<_>>() {
            let is_dir = batch.disk.get(&path).copied().flatten().map(|s| s.kind) == Some(Kind::Dir);
            if is_dir && view.get(&path).map(|s| s.kind) != Some(Kind::Dir) {
                batch.expand(&path);
            }
        }

        // --- Phase B: additions, modifications, replacements --------------------
        let mut changes: Vec<SyncOp> = Vec::new();
        let mut removal_candidates: Vec<String> = Vec::new();
        let mut retry: Vec<String> = Vec::new();
        for path in sort_paths(batch.candidates.iter().cloned()) {
            let now = match batch.disk.get(&path) {
                Some(cached) => *cached,
                None => batch.look(&path),
            };
            let known = view.get(&path);
            if now.is_none() {
                core.deferrals.remove(&path);
            }
            if known.is_none() && now.is_none() {
                core.pending_removals.remove(&path);
                continue;
            }
            if let Some(found) = now {
                if found.kind == Kind::File && (known.is_none() || !same_state(known.as_ref(), Some(&found))) {
                    // Hint 3: still being written? Look again once it settles.
                    let age = now_ms() - found.mtime_ms;
                    let attempts = core.deferrals.get(&path).copied().unwrap_or(0);
                    if (0..self.timing.stability_ms).contains(&age) && attempts < 50 {
                        core.deferrals.insert(path.clone(), attempts + 1);
                        retry.push(path);
                        continue;
                    }
                    core.deferrals.remove(&path);
                }
            }
            match (known, now) {
                (None, Some(found)) => {
                    changes.push(if found.kind == Kind::Dir {
                        SyncOp::Mkdir { path: path.clone(), state: Some(found) }
                    } else {
                        SyncOp::Write { path: path.clone(), state: Some(found), base: None }
                    });
                    view.set(&path, Some(found));
                    core.pending_removals.remove(&path);
                }
                (Some(_), None) => removal_candidates.push(path),
                (Some(known), Some(found)) => {
                    core.pending_removals.remove(&path);
                    if known.kind != found.kind {
                        // Replaced by another kind of entry: the peer must remove
                        // the old one before it can create the new one.
                        changes.push(if known.kind == Kind::Dir {
                            SyncOp::Rmdir { path: path.clone() }
                        } else {
                            SyncOp::Unlink { path: path.clone(), base: Some(known) }
                        });
                        changes.push(if found.kind == Kind::Dir {
                            SyncOp::Mkdir { path: path.clone(), state: Some(found) }
                        } else {
                            SyncOp::Write { path: path.clone(), state: Some(found), base: None }
                        });
                        view.delete_tree(&path);
                        view.set(&path, Some(found));
                    } else if found.kind == Kind::File && !same_state(Some(&known), Some(&found)) {
                        changes.push(SyncOp::Write { path: path.clone(), state: Some(found), base: Some(known) });
                        view.set(&path, Some(found));
                    } else if known.id != found.id {
                        // Same content under a new inode (an editor's atomic save
                        // that wrote identical bytes): only bookkeeping.
                        changes.push(SyncOp::Reindex { path: path.clone(), state: found });
                        view.set(&path, Some(found));
                    }
                }
                (None, None) => {}
            }
        }

        // --- Phase C: removals, held back while a rename could complete ----------
        // Group every removed path under its top-most removed ancestor, in one
        // pass (a deleted tree can hold tens of thousands of entries).
        let removal_set: HashSet<&str> = removal_candidates.iter().map(String::as_str).collect();
        let mut groups: Vec<(String, Vec<String>)> = Vec::new();
        let mut group_of: HashMap<String, usize> = HashMap::new();
        for path in &removal_candidates {
            let mut top = path.as_str();
            let mut cut = path.len();
            while let Some(index) = path[..cut].rfind('/') {
                if index == 0 {
                    break;
                }
                if removal_set.contains(&path[..index]) {
                    top = &path[..index];
                }
                cut = index;
            }
            let slot = *group_of.entry(top.to_string()).or_insert_with(|| {
                groups.push((top.to_string(), Vec::new()));
                groups.len() - 1
            });
            groups[slot].1.push(path.clone());
        }
        let mut removals: Vec<SyncOp> = Vec::new();
        core.next_removal_due = 0;
        for (top, group) in &groups {
            for path in group {
                core.pending_removals.entry(path.clone()).or_insert(started);
            }
            let newest = group.iter().map(|path| core.pending_removals[path]).max().unwrap_or(started);
            let due = newest + self.timing.rename_window_ms;
            if now_ms() < due {
                core.next_removal_due = if core.next_removal_due > 0 { core.next_removal_due.min(due) } else { due };
                continue;
            }
            for path in group {
                core.pending_removals.remove(path);
            }
            let known = view.get(top);
            removals.push(match known.map(|k| k.kind) {
                Some(Kind::Dir) => SyncOp::Rmdir { path: top.clone() },
                _ => SyncOp::Unlink { path: top.clone(), base: known },
            });
        }
        // Forget pending removals that are no longer candidates for any reason.
        core.pending_removals.retain(|path, _| removal_set.contains(path.as_str()));
        removals.sort_by_key(|op| std::cmp::Reverse(depth_of(op.path())));

        if !retry.is_empty() {
            for path in &retry {
                core.touched.insert(path.clone());
            }
            core.next_retry_due = now_ms() + (self.timing.stability_ms / 2).max(20);
        }

        // Directories that vanished or moved away release their watches; a
        // moved directory got new ones at its new location above.
        if !self.tree.recursive() {
            let gone: Vec<String> = batch
                .candidates
                .iter()
                .filter(|path| {
                    self.tree.has(path) && batch.disk.get(*path).copied().flatten().map(|s| s.kind) != Some(Kind::Dir)
                })
                .cloned()
                .collect();
            self.tree.remove(&gone);
        }

        let mut ops = renames;
        ops.extend(changes);
        ops.extend(removals);
        if self.logger.enabled(crate::util::logger::Level::Debug) {
            self.logger.debug(format_args!(
                "batch: {} path(s) examined in {} ms, {} operation(s){}{}",
                batch.candidates.len(),
                now_ms() - started,
                ops.len(),
                if core.pending_removals.is_empty() {
                    String::new()
                } else {
                    format!(", {} removal(s) held back", core.pending_removals.len())
                },
                if retry.is_empty() { String::new() } else { format!(", {} file(s) still changing", retry.len()) },
            ));
        }
        (ops, false)
    }
}
