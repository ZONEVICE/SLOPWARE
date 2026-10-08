//! The change detector against a real directory.
//!
//! What matters is the operations it derives, not the raw notifications: a
//! rename must come out as a rename (not a deletion plus an upload), a deleted
//! tree as one removal, and a change applied through the index as nothing.

use reptile::fs::entry::{read_state, State};
use reptile::fs::index::{commit_op, FileIndex};
use reptile::fs::ops::SyncOp;
use reptile::fs::walk::walk_all;
use reptile::fs::watcher::{BatchHooks, Filters, WatchOwner, Watcher, WatcherTiming};
use reptile::util::ids::random_hex;
use reptile::util::logger::Logger;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant};

const FAST: WatcherTiming =
    WatcherTiming { quiet_ms: 40, max_wait_ms: 300, rename_window_ms: 350, stability_ms: 80, rescan_interval_ms: 0 };

type Predicate = Arc<dyn Fn(&str) -> bool + Send + Sync>;

struct Owner {
    index: Mutex<FileIndex>,
    batches: Mutex<Vec<Vec<SyncOp>>>,
    ignore: Predicate,
    ignore_inside: Predicate,
    missing: AtomicUsize,
}

struct Hooks {
    ignore: Predicate,
    ignore_inside: Predicate,
}

impl BatchHooks for Hooks {
    fn ignore(&self, wire: &str) -> bool {
        (self.ignore)(wire)
    }
    fn ignore_inside(&self, wire: &str) -> bool {
        (self.ignore_inside)(wire)
    }
}

impl WatchOwner for Owner {
    fn batch(&self, diff: &mut dyn FnMut(&FileIndex, &mut dyn BatchHooks) -> Vec<SyncOp>) {
        let mut index = self.index.lock().unwrap();
        let mut hooks = Hooks { ignore: self.ignore.clone(), ignore_inside: self.ignore_inside.clone() };
        let ops = diff(&index, &mut hooks);
        for op in &ops {
            commit_op(&mut index, op);
        }
        if !ops.is_empty() {
            self.batches.lock().unwrap().push(ops);
        }
    }
    fn inspect(&self, look: &mut dyn FnMut(&FileIndex)) {
        look(&self.index.lock().unwrap());
    }
    fn filters(&self) -> Filters {
        let (a, b) = (self.ignore.clone(), self.ignore_inside.clone());
        Filters { ignore: Box::new(move |w| a(w)), ignore_inside: Box::new(move |w| b(w)) }
    }
    fn root_missing(&self) {
        self.missing.fetch_add(1, Ordering::SeqCst);
    }
    fn report_error(&self, _message: String) {}
}

struct Harness {
    root: PathBuf,
    owner: Arc<Owner>,
    watcher: Watcher,
}

impl Harness {
    fn new(files: &[(&str, Option<&str>)]) -> Harness {
        Harness::with(files, Arc::new(|_: &str| false), None)
    }

    fn with(files: &[(&str, Option<&str>)], ignore: Predicate, ignore_inside: Option<Predicate>) -> Harness {
        let root = std::env::temp_dir().join(format!("reptile-watch-{}", random_hex(6)));
        fs::create_dir_all(&root).unwrap();
        write_tree(&root, files);
        let owner = Arc::new(Owner {
            index: Mutex::new(FileIndex::new()),
            batches: Mutex::new(Vec::new()),
            ignore_inside: ignore_inside.unwrap_or_else(|| ignore.clone()),
            ignore,
            missing: AtomicUsize::new(0),
        });
        let watcher = Watcher::start(&root, owner.clone(), FAST, Logger::silent()).unwrap();
        owner.index.lock().unwrap().replace_all(walk_all(&root).unwrap());
        Harness { root, owner, watcher }
    }

    fn all(&self) -> Vec<SyncOp> {
        self.owner
            .batches
            .lock()
            .unwrap()
            .iter()
            .flatten()
            .filter(|op| !matches!(op, SyncOp::Reindex { .. }))
            .cloned()
            .collect()
    }

    fn summary(&self) -> Vec<String> {
        self.all().iter().map(SyncOp::summary).collect()
    }

    fn wait_for(&self, what: &str, condition: impl Fn(&Harness) -> bool) {
        let started = Instant::now();
        while !condition(self) {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "timed out waiting for {what}; saw {:?}",
                self.summary()
            );
            sleep(Duration::from_millis(20));
        }
    }

    fn reset(&self) {
        self.owner.batches.lock().unwrap().clear();
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.watcher.close();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn write_tree(root: &Path, files: &[(&str, Option<&str>)]) {
    for (path, content) in files {
        let target = root.join(path);
        match content {
            None => fs::create_dir_all(&target).unwrap(),
            Some(text) => {
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                fs::write(&target, text).unwrap();
            }
        }
    }
}

fn has(h: &Harness, line: &str) -> bool {
    h.summary().iter().any(|s| s == line)
}

#[test]
fn a_new_file_is_a_write_and_a_new_directory_a_mkdir_parents_first() {
    let h = Harness::new(&[]);
    fs::create_dir_all(h.root.join("x/y")).unwrap();
    fs::write(h.root.join("x/y/z.txt"), "zz").unwrap();
    h.wait_for("write x/y/z.txt", |h| has(h, "write x/y/z.txt"));
    let summary = h.summary();
    let at = |line: &str| summary.iter().position(|s| s == line).unwrap();
    assert!(at("mkdir x") < at("mkdir x/y"));
    assert!(at("mkdir x/y") < at("write x/y/z.txt"));
    let write = h.all().into_iter().find(|op| op.path() == "x/y/z.txt").unwrap();
    match write {
        SyncOp::Write { state, base, .. } => {
            assert_eq!(state.unwrap().size, 2);
            assert!(base.is_none());
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn a_modification_is_a_write_carrying_the_previous_state() {
    let h = Harness::new(&[("a.txt", Some("one"))]);
    let before = *h.owner.index.lock().unwrap().get("a.txt").unwrap();
    sleep(Duration::from_millis(20));
    fs::write(h.root.join("a.txt"), "one two").unwrap();
    h.wait_for("write a.txt", |h| has(h, "write a.txt"));
    match h.all().into_iter().find(|op| op.path() == "a.txt").unwrap() {
        SyncOp::Write { state, base, .. } => {
            assert_eq!(state.unwrap().size, 7);
            assert_eq!(base.unwrap().size, before.size);
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn renaming_a_file_is_one_rename_not_a_deletion_and_an_upload() {
    let h = Harness::new(&[("old.txt", Some("content"))]);
    fs::rename(h.root.join("old.txt"), h.root.join("new.txt")).unwrap();
    h.wait_for("the rename", |h| has(h, "rename old.txt -> new.txt"));
    sleep(Duration::from_millis(FAST.rename_window_ms as u64 + 200));
    assert_eq!(h.summary(), vec!["rename old.txt -> new.txt"]);
}

#[test]
fn renaming_a_directory_moves_its_whole_content_in_one_operation() {
    let h = Harness::new(&[("dir/a.txt", Some("a")), ("dir/sub/b.txt", Some("b"))]);
    fs::rename(h.root.join("dir"), h.root.join("moved")).unwrap();
    h.wait_for("the rename", |h| has(h, "rename dir -> moved"));
    sleep(Duration::from_millis(FAST.rename_window_ms as u64 + 300));
    assert_eq!(h.summary(), vec!["rename dir -> moved"]);
    let mut keys: Vec<String> = h.owner.index.lock().unwrap().iter().map(|(k, _)| k.clone()).collect();
    keys.sort();
    assert_eq!(keys, vec!["moved", "moved/a.txt", "moved/sub", "moved/sub/b.txt"]);
}

#[test]
fn moving_a_file_into_another_directory_is_a_rename_too() {
    let h = Harness::new(&[("a.txt", Some("a")), ("box", None)]);
    fs::rename(h.root.join("a.txt"), h.root.join("box/a.txt")).unwrap();
    h.wait_for("the rename", |h| has(h, "rename a.txt -> box/a.txt"));
}

#[test]
fn deleting_a_file_is_reported_after_the_rename_window() {
    let h = Harness::new(&[("gone.txt", Some("bye"))]);
    let started = Instant::now();
    fs::remove_file(h.root.join("gone.txt")).unwrap();
    h.wait_for("unlink", |h| has(h, "unlink gone.txt"));
    assert!(
        started.elapsed().as_millis() as i64 >= FAST.rename_window_ms - 50,
        "held back while a rename could still complete"
    );
    match h.all().into_iter().find(|op| op.name() == "unlink").unwrap() {
        SyncOp::Unlink { base, .. } => assert_eq!(base.unwrap().size, 3, "the deletion says which version was deleted"),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn deleting_a_tree_is_one_rmdir_not_one_operation_per_file() {
    let h = Harness::new(&[("tree/a", Some("a")), ("tree/b/c", Some("c")), ("tree/b/d/e", Some("e"))]);
    fs::remove_dir_all(h.root.join("tree")).unwrap();
    h.wait_for("rmdir tree", |h| has(h, "rmdir tree"));
    sleep(Duration::from_millis(200));
    assert_eq!(h.summary(), vec!["rmdir tree"]);
    assert!(h.owner.index.lock().unwrap().is_empty());
}

#[test]
fn a_file_replaced_by_a_directory_is_removal_first_then_creation() {
    let h = Harness::new(&[("thing", Some("file"))]);
    fs::remove_file(h.root.join("thing")).unwrap();
    fs::create_dir(h.root.join("thing")).unwrap();
    h.wait_for("mkdir thing", |h| has(h, "mkdir thing"));
    let summary = h.summary();
    let from = summary.iter().position(|s| s == "unlink thing").unwrap();
    assert_eq!(summary[from..], ["unlink thing".to_string(), "mkdir thing".to_string()]);
}

#[test]
fn a_change_already_recorded_in_the_index_is_not_reported() {
    let h = Harness::new(&[]);
    // A change applied on behalf of the peer: index first, disk second.
    fs::write(h.root.join("from-peer.txt"), "peer").unwrap();
    let state: State = read_state(&h.root.join("from-peer.txt")).unwrap().unwrap();
    h.owner.index.lock().unwrap().set("from-peer.txt", state);
    sleep(Duration::from_millis((FAST.stability_ms + FAST.max_wait_ms + 300) as u64));
    assert!(h.summary().is_empty(), "{:?}", h.summary());
}

#[test]
fn ignored_paths_are_never_reported() {
    let h = Harness::with(&[], Arc::new(|path: &str| path.starts_with("private")), None);
    fs::create_dir(h.root.join("private")).unwrap();
    fs::write(h.root.join("private/secret.txt"), "x").unwrap();
    fs::write(h.root.join("public.txt"), "y").unwrap();
    h.wait_for("write public.txt", |h| has(h, "write public.txt"));
    sleep(Duration::from_millis(300));
    assert!(!h.summary().iter().any(|line| line.contains("private")));
}

#[test]
fn a_vanished_root_is_never_read_as_everything_was_deleted() {
    let h = Harness::new(&[("a.txt", Some("a")), ("b/c.txt", Some("c"))]);
    fs::remove_dir_all(&h.root).unwrap();
    h.wait_for("root missing", |h| h.owner.missing.load(Ordering::SeqCst) > 0);
    sleep(Duration::from_millis(FAST.rename_window_ms as u64 + 200));
    assert!(!h.summary().iter().any(|line| line.starts_with("unlink") || line.starts_with("rmdir")));
}

#[test]
fn a_renamed_directory_is_still_watched_at_its_new_location() {
    let h = Harness::new(&[("dir/a.txt", Some("a")), ("dir/sub/b.txt", Some("b"))]);
    fs::rename(h.root.join("dir"), h.root.join("moved")).unwrap();
    h.wait_for("the rename", |h| has(h, "rename dir -> moved"));
    h.reset();
    fs::write(h.root.join("moved/new.txt"), "new").unwrap();
    fs::write(h.root.join("moved/sub/b.txt"), "b more").unwrap();
    h.wait_for("changes below the renamed directory", |h| {
        has(h, "write moved/new.txt") && has(h, "write moved/sub/b.txt")
    });
    assert!(!h.summary().iter().any(|line| line.contains(" dir/")), "nothing is attributed to the old name");
}

#[test]
fn a_directory_recorded_in_the_index_first_is_watched_too() {
    let h = Harness::new(&[]);
    fs::create_dir(h.root.join("made")).unwrap();
    let state = read_state(&h.root.join("made")).unwrap().unwrap();
    h.owner.index.lock().unwrap().set("made", state);
    sleep(Duration::from_millis(FAST.max_wait_ms as u64 + 100));
    fs::write(h.root.join("made/later.txt"), "later").unwrap();
    h.wait_for("write made/later.txt", |h| has(h, "write made/later.txt"));
    assert!(!has(&h, "mkdir made"), "the directory itself is not echoed");
}

#[test]
fn deleted_directories_release_their_watches() {
    let h = Harness::new(&[("a/x.txt", Some("x")), ("a/b/y.txt", Some("y")), ("keep/z.txt", Some("z"))]);
    if h.watcher.recursive() {
        assert!(h.watcher.watching() <= 1);
        return;
    }
    assert_eq!(h.watcher.watching(), 4, "the root, a, a/b and keep");
    fs::remove_dir_all(h.root.join("a")).unwrap();
    h.wait_for("rmdir a", |h| has(h, "rmdir a"));
    h.wait_for("released watches", |h| h.watcher.watching() == 2);
}

#[test]
fn the_inside_of_an_ignore_inside_directory_is_never_watched() {
    let h = Harness::with(
        &[("private/secret.txt", Some("s")), ("public/open.txt", Some("o"))],
        Arc::new(|path: &str| path.starts_with("private/") || path.starts_with("hidden/")),
        Some(Arc::new(|path: &str| path == "private" || path == "hidden")),
    );
    if !h.watcher.recursive() {
        assert_eq!(h.watcher.watching(), 2, "the root and public, not private");
    }
    fs::write(h.root.join("private/more.txt"), "m").unwrap();
    fs::rename(h.root.join("private"), h.root.join("hidden")).unwrap();
    h.wait_for("the rename of the directory itself", |h| has(h, "rename private -> hidden"));
    assert!(!h.summary().iter().any(|line| line.contains("secret") || line.contains("more")));
}

#[test]
fn bursts_are_batched() {
    let h = Harness::new(&[]);
    for index in 0..20 {
        fs::write(h.root.join(format!("f{index}.txt")), index.to_string()).unwrap();
    }
    h.wait_for("20 writes", |h| h.summary().iter().filter(|l| l.starts_with("write")).count() == 20);
    assert!(h.owner.batches.lock().unwrap().len() < 20);
}

#[test]
fn a_file_still_being_written_is_reported_once_it_settles() {
    let h = Harness::new(&[]);
    let path = h.root.join("growing.bin");
    for chunk in 0..5 {
        let mut content = fs::read(&path).unwrap_or_default();
        content.extend(std::iter::repeat_n(chunk as u8, 1000));
        fs::write(&path, content).unwrap();
        sleep(Duration::from_millis(30));
    }
    h.wait_for("the final write", |h| {
        h.all().iter().any(
            |op| matches!(op, SyncOp::Write { path, state: Some(s), .. } if path == "growing.bin" && s.size == 5000),
        )
    });
}
