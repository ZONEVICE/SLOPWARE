//! Synchronisation end to end: two in-process instances over real HTTP.

mod common;

use common::*;
use reptile::fs::entry::read_state;
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::thread::sleep;
use std::time::Duration;

#[cfg(unix)]
fn inode(path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).unwrap().ino()
}

#[cfg(not(unix))]
fn inode(path: &Path) -> u64 {
    read_state(path).unwrap().unwrap().id.unwrap().1
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

// --- Initial synchronisation ---------------------------------------------------------

#[test]
fn the_hosts_content_is_copied_into_an_empty_local_directory() {
    let pair = pair(&[("a.txt", Some("alpha")), ("dir/b.txt", Some("beta")), ("dir/sub/", None), ("empty/", None)]);
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 10_000);
    assert_eq!(read(&pair.sync_dir.join("dir/b.txt")), "beta");
    assert!(pair.sync_dir.join("empty").is_dir());
}

#[test]
fn modification_times_travel_with_the_content() {
    let pair = connected_pair_with("http", &[("old.txt", Some("old"))], None, &[], "1234", |host, _| {
        reptile::fs::mutate::set_times(&host.join("old.txt"), 1_500_000_000_123).unwrap();
    });
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 10_000);
    let state = read_state(&pair.sync_dir.join("old.txt")).unwrap().unwrap();
    assert_eq!(state.mtime_ms, 1_500_000_000_123);
}

#[test]
fn what_only_the_peer_has_is_sent_to_the_host() {
    let pair = connected_pair(
        "http",
        &[("host-only.txt", Some("h"))],
        Some(&[("peer-only.txt", Some("p")), ("peer-dir/x.txt", Some("x"))]),
        &[],
        "1234",
    );
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 10_000);
    assert_eq!(read(&pair.host_dir.path().join("peer-dir/x.txt")), "x");
    assert_eq!(read(&pair.sync_dir.join("host-only.txt")), "h");
}

#[test]
fn when_both_have_a_different_version_the_newer_one_wins() {
    let files = [("newer-on-host.txt", Some("HOST VERSION")), ("newer-on-peer.txt", Some("host version"))];
    let local = [("newer-on-host.txt", Some("peer version")), ("newer-on-peer.txt", Some("PEER VERSION"))];
    let pair = connected_pair_with("http", &files, Some(&local), &[], "1234", |host, sync| {
        let set = |path: &Path, ms: i64| reptile::fs::mutate::set_times(path, ms).unwrap();
        set(&host.join("newer-on-host.txt"), 2_000_000_000_000);
        set(&sync.join("newer-on-host.txt"), 1_000_000_000_000);
        set(&host.join("newer-on-peer.txt"), 1_000_000_000_000);
        set(&sync.join("newer-on-peer.txt"), 2_000_000_000_000);
    });
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 10_000);
    assert_eq!(read(&pair.sync_dir.join("newer-on-host.txt")), "HOST VERSION");
    assert_eq!(read(&pair.host_dir.path().join("newer-on-peer.txt")), "PEER VERSION");
}

#[test]
fn identical_content_with_different_mtimes_is_compared_by_hash_not_copied() {
    let mut local_inode = 0;
    let pair = connected_pair_with(
        "http",
        &[("same.bin", Some("identical bytes"))],
        Some(&[("same.bin", Some("identical bytes"))]),
        &[],
        "1234",
        |host, sync| {
            reptile::fs::mutate::set_times(&host.join("same.bin"), 1_700_000_000_000).unwrap();
            reptile::fs::mutate::set_times(&sync.join("same.bin"), 1_600_000_000_000).unwrap();
            local_inode = inode(&sync.join("same.bin"));
        },
    );
    let state = read_state(&pair.sync_dir.join("same.bin")).unwrap().unwrap();
    assert_eq!(state.mtime_ms, 1_700_000_000_000, "the host's mtime was adopted");
    assert_eq!(inode(&pair.sync_dir.join("same.bin")), local_inode, "not transferred again");
}

#[test]
fn large_and_binary_files_arrive_intact_and_odd_names_too() {
    let big: Vec<u8> = (0..3 * 1024 * 1024).map(|i| (i * 31 % 251) as u8).collect();
    let pair = pair(&[("odd name ñ #1 (copy) & more.txt", Some("odd")), ("empty-file", Some(""))]);
    fs::write(pair.host_dir.path().join("big.bin"), &big).unwrap();
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 20_000);
    assert_eq!(fs::read(pair.sync_dir.join("big.bin")).unwrap(), big);
    assert_eq!(fs::metadata(pair.sync_dir.join("empty-file")).unwrap().len(), 0);
}

// --- Live synchronisation, both directions ------------------------------------------------

/// Run a scenario with `from` the side where the user works and `to` where
/// the change must appear, in both directions.
fn both_directions(files: &[(&str, Option<&str>)], scenario: impl Fn(&Path, &Path)) {
    for host_side in [true, false] {
        let pair = pair(files);
        wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 10_000);
        let (from, to) = if host_side {
            (pair.host_dir.path().to_path_buf(), pair.sync_dir.clone())
        } else {
            (pair.sync_dir.clone(), pair.host_dir.path().to_path_buf())
        };
        scenario(&from, &to);
    }
}

#[test]
fn creating_a_file() {
    both_directions(&[], |from, to| {
        fs::write(from.join("new.txt"), "brand new").unwrap();
        wait_for("the new file", 10_000, || read(&to.join("new.txt")) == "brand new");
        wait_same_trees(from, to, 10_000);
    });
}

#[test]
fn creating_nested_directories_with_files() {
    both_directions(&[], |from, to| {
        fs::create_dir_all(from.join("a/b/c")).unwrap();
        fs::write(from.join("a/b/c/leaf.txt"), "leaf").unwrap();
        fs::create_dir(from.join("a/empty")).unwrap();
        wait_same_trees(from, to, 10_000);
    });
}

#[test]
fn modifying_a_file() {
    both_directions(&[("doc.txt", Some("version 1"))], |from, to| {
        fs::write(from.join("doc.txt"), "version 2, longer").unwrap();
        wait_for("the modification", 10_000, || read(&to.join("doc.txt")) == "version 2, longer");
        sleep(Duration::from_millis(20));
        let mut appended = read(&from.join("doc.txt"));
        appended.push_str(" + appended");
        fs::write(from.join("doc.txt"), appended).unwrap();
        wait_for("the append", 10_000, || read(&to.join("doc.txt")).ends_with("+ appended"));
        wait_same_trees(from, to, 10_000);
    });
}

#[test]
fn renaming_a_file_renames_it_in_place() {
    both_directions(&[("before.txt", Some("keep my bytes"))], |from, to| {
        let before = inode(&to.join("before.txt"));
        fs::rename(from.join("before.txt"), from.join("after.txt")).unwrap();
        wait_for("the renamed file", 10_000, || to.join("after.txt").exists());
        wait_same_trees(from, to, 10_000);
        assert_eq!(inode(&to.join("after.txt")), before, "renamed in place, not transferred again");
        assert!(!to.join("before.txt").exists());
    });
}

#[test]
fn moving_a_file_to_another_directory() {
    both_directions(&[("inbox/letter.txt", Some("dear")), ("archive/", None)], |from, to| {
        let before = inode(&to.join("inbox/letter.txt"));
        fs::rename(from.join("inbox/letter.txt"), from.join("archive/letter.txt")).unwrap();
        wait_for("the moved file", 10_000, || to.join("archive/letter.txt").exists());
        wait_same_trees(from, to, 10_000);
        assert_eq!(inode(&to.join("archive/letter.txt")), before);
    });
}

#[test]
fn renaming_a_directory() {
    both_directions(
        &[("project/src/main.rs", Some("code")), ("project/README.md", Some("readme")), ("project/empty/", None)],
        |from, to| {
            let before = (inode(&to.join("project")), inode(&to.join("project/src/main.rs")));
            fs::rename(from.join("project"), from.join("renamed-project")).unwrap();
            wait_for("the renamed directory", 10_000, || to.join("renamed-project/src/main.rs").exists());
            wait_same_trees(from, to, 10_000);
            assert_eq!((inode(&to.join("renamed-project")), inode(&to.join("renamed-project/src/main.rs"))), before);
        },
    );
}

#[test]
fn deleting_a_file() {
    both_directions(&[("keep.txt", Some("k")), ("remove.txt", Some("r"))], |from, to| {
        fs::remove_file(from.join("remove.txt")).unwrap();
        wait_for("the deletion", 10_000, || !to.join("remove.txt").exists());
        wait_same_trees(from, to, 10_000);
        assert_eq!(read(&to.join("keep.txt")), "k");
    });
}

#[test]
fn deleting_a_directory_tree() {
    both_directions(
        &[
            ("tree/a.txt", Some("a")),
            ("tree/sub/b.txt", Some("b")),
            ("tree/sub/deeper/c.txt", Some("c")),
            ("other.txt", Some("o")),
        ],
        |from, to| {
            fs::remove_dir_all(from.join("tree")).unwrap();
            wait_for("the tree deletion", 10_000, || !to.join("tree").exists());
            wait_same_trees(from, to, 10_000);
        },
    );
}

#[test]
fn replacing_a_file_with_a_directory_of_the_same_name() {
    both_directions(&[("thing", Some("I am a file"))], |from, to| {
        fs::remove_file(from.join("thing")).unwrap();
        fs::create_dir(from.join("thing")).unwrap();
        fs::write(from.join("thing/inside.txt"), "now a directory").unwrap();
        wait_for("the directory", 10_000, || to.join("thing").is_dir());
        wait_same_trees(from, to, 10_000);
    });
}

#[test]
fn a_burst_of_changes_on_both_sides_at_once_converges() {
    let pair = pair(&[("shared/a.txt", Some("a"))]);
    for index in 0..15 {
        fs::write(pair.host_dir.path().join(format!("host-{index}.txt")), format!("h{index}")).unwrap();
        fs::write(pair.sync_dir.join(format!("peer-{index}.txt")), format!("p{index}")).unwrap();
    }
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 15_000);
    let names = fs::read_dir(pair.host_dir.path())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("peer-"))
        .count();
    assert_eq!(names, 15);
}

#[test]
fn both_sides_editing_the_same_file_end_with_the_newer_version() {
    let pair = pair(&[("contested.txt", Some("original"))]);
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 10_000);
    fs::write(pair.sync_dir.join("contested.txt"), "peer edit").unwrap();
    sleep(Duration::from_millis(30));
    fs::write(pair.host_dir.path().join("contested.txt"), "host edit, a bit later").unwrap();
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 15_000);
    assert_eq!(read(&pair.host_dir.path().join("contested.txt")), "host edit, a bit later");
}

#[test]
fn nothing_bounces_back() {
    let pair = pair(&[]);
    fs::write(pair.host_dir.path().join("once.txt"), "once").unwrap();
    wait_for("the file", 10_000, || pair.sync_dir.join("once.txt").exists());
    sleep(Duration::from_millis(1200));
    let count = |status: &Value| {
        status["activity"].as_array().unwrap().iter().filter(|e| e["kind"] == "sent" && e["path"] == "once.txt").count()
    };
    assert_eq!(count(&pair.host.app.hosting.status()), 1, "downloaded once");
    assert_eq!(count(&pair.client.app.syncing.status()), 0, "never echoed back to the host");
    assert_eq!(snapshot_tree(pair.host_dir.path()), snapshot_tree(&pair.sync_dir));
}

// --- Safety ----------------------------------------------------------------------------------

#[test]
fn if_the_local_copy_disappears_syncing_stops_and_nothing_is_deleted_on_the_host() {
    let pair = pair(&[("precious.txt", Some("keep me")), ("dir/also.txt", Some("me too"))]);
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 10_000);
    fs::remove_dir_all(&pair.sync_dir).unwrap();
    wait_for("the peer to stop", 10_000, || pair.client.sync_state() == Some("error"));
    assert!(pair.client.app.syncing.status()["notice"]["message"].as_str().unwrap().contains("disappeared"));
    sleep(Duration::from_millis(800));
    assert_eq!(read(&pair.host_dir.path().join("precious.txt")), "keep me");
    assert_eq!(read(&pair.host_dir.path().join("dir/also.txt")), "me too");
}

#[test]
fn if_the_hosted_directory_disappears_hosting_stops_and_nothing_is_deleted_on_the_peer() {
    let pair = pair(&[("precious.txt", Some("keep me"))]);
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 10_000);
    fs::remove_dir_all(pair.host_dir.path()).unwrap();
    wait_for("hosting to stop", 10_000, || pair.host.app.modes.mode() == "idle");
    assert!(pair.host.app.hosting.status()["notice"]["message"].as_str().unwrap().contains("disappeared"));
    wait_for("the peer to be told", 10_000, || pair.client.sync_state() == Some("stopped"));
    assert_eq!(read(&pair.sync_dir.join("precious.txt")), "keep me");
}

#[test]
fn temporary_transfer_files_never_show_up_on_either_side() {
    let pair = pair(&[]);
    fs::write(pair.host_dir.path().join("big.bin"), vec![7u8; 2 * 1024 * 1024]).unwrap();
    wait_same_trees(pair.host_dir.path(), &pair.sync_dir, 15_000);
    for directory in [pair.host_dir.path(), pair.sync_dir.as_path()] {
        assert!(!fs::read_dir(directory)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with(".reptile-")));
    }
}
