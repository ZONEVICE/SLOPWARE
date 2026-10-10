//! Disk mutations performed on behalf of a peer.
//!
//! Every function takes the synced root and a wire path that was already
//! normalised. On top of the lexical containment check in `wire::resolve`,
//! these functions refuse to traverse a symbolic link on the way to the
//! target: a link inside the shared directory pointing at /etc must not let a
//! peer write to /etc.
//!
//! Files are received in two phases (`stage_file`, then `Staged::commit`) so
//! that the caller can take its lock only for the instant the file is renamed
//! into place, not for the whole transfer.

use crate::fs::entry::{is_temp_name, read_state, read_state_lossy, temp_name, Kind, State};
use crate::util::wire::{self, join, parent_of};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// A failed mutation: a condition with a machine code the peer should learn
/// about, or a plain I/O error.
#[derive(Debug)]
pub enum FsError {
    /// `conflict`, `unsafe_path`, `not_found`, `size_mismatch`.
    Code(&'static str, String),
    Io(io::Error),
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FsError::Code(_, message) => f.write_str(message),
            FsError::Io(error) => write!(f, "{error}"),
        }
    }
}

impl From<io::Error> for FsError {
    fn from(error: io::Error) -> Self {
        FsError::Io(error)
    }
}

pub type FsResult<T> = Result<T, FsError>;

fn code(code: &'static str, message: impl Into<String>) -> FsError {
    FsError::Code(code, message.into())
}

/// Resolve a wire path and verify that every EXISTING ancestor between the
/// root and the target is a real directory, not a symlink or a file.
pub fn resolve_safely(root: &Path, wire_path: &str) -> FsResult<PathBuf> {
    let target = wire::resolve(root, wire_path).map_err(|message| code("unsafe_path", message))?;
    if wire_path.is_empty() {
        return Ok(target);
    }
    let segments: Vec<&str> = wire_path.split('/').collect();
    let mut current = root.to_path_buf();
    for index in 0..segments.len() - 1 {
        current.push(segments[index]);
        let state = match read_state(&current)? {
            Some(state) => state,
            None => return Ok(target), // the rest will be created
        };
        let prefix = segments[..=index].join("/");
        match state.kind {
            Kind::Other => return Err(code("unsafe_path", format!("Refusing to follow a symbolic link at {prefix}."))),
            Kind::File => return Err(code("conflict", format!("{prefix} is a file, not a directory."))),
            Kind::Dir => {}
        }
    }
    Ok(target)
}

/// Create a directory and any missing parents, one level at a time, never
/// through a symlink. Returns the directories that were created, parents first.
pub fn ensure_directory(root: &Path, wire_path: &str) -> FsResult<Vec<(String, State)>> {
    let mut created = Vec::new();
    if wire_path.is_empty() {
        return Ok(created);
    }
    let mut current = String::new();
    for segment in wire_path.split('/') {
        current = join(&current, segment);
        let absolute = wire::resolve(root, &current).map_err(|message| code("unsafe_path", message))?;
        let mut state = read_state(&absolute)?;
        if state.is_none() {
            match fs::create_dir(&absolute) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
            state = read_state(&absolute)?;
            if let Some(dir) = state.filter(|s| s.kind == Kind::Dir) {
                created.push((current.clone(), dir));
                continue;
            }
        }
        if state.map(|s| s.kind) != Some(Kind::Dir) {
            return Err(code("conflict", format!("{current} exists and is not a directory.")));
        }
    }
    Ok(created)
}

/// Set a path's access and modification times to `mtime_ms`.
#[cfg(unix)]
pub fn set_times(path: &Path, mtime_ms: i64) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(io::Error::other)?;
    let spec = libc::timespec {
        tv_sec: mtime_ms.div_euclid(1000) as libc::time_t,
        tv_nsec: (mtime_ms.rem_euclid(1000) * 1_000_000) as libc::c_long,
    };
    let times = [spec, spec];
    // SAFETY: a valid NUL-terminated path and two timespecs.
    let result = unsafe { libc::utimensat(libc::AT_FDCWD, c_path.as_ptr(), times.as_ptr(), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
pub fn set_times(path: &Path, mtime_ms: i64) -> io::Result<()> {
    let when = crate::util::time::system_time(mtime_ms);
    let mut options = OpenOptions::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Attribute access only: works on read-only files too.
        options.access_mode(windows_sys::Win32::Storage::FileSystem::FILE_WRITE_ATTRIBUTES);
    }
    #[cfg(not(windows))]
    options.write(true);
    let file = options.open(path)?;
    file.set_times(fs::FileTimes::new().set_accessed(when).set_modified(when))
}

/// A received file waiting to be renamed into place.
pub struct Staged {
    pub state: State,
    pub temp_path: PathBuf,
    pub target_path: PathBuf,
    wire_path: String,
}

impl Staged {
    /// Rename into place. Refuses to replace a directory or a special file.
    pub fn commit(&self) -> FsResult<()> {
        match read_state(&self.target_path)?.map(|s| s.kind) {
            Some(Kind::Dir) => return Err(code("conflict", format!("{} is a directory.", self.wire_path))),
            Some(Kind::Other) => {
                return Err(code("conflict", format!("{} is a special file or a link.", self.wire_path)))
            }
            _ => {}
        }
        if let Err(error) = fs::rename(&self.temp_path, &self.target_path) {
            // Windows refuses to replace a read-only file (POSIX replaces it as
            // long as the directory is writable). Clear the attribute and retry
            // once; otherwise a read-only file on the peer would never update.
            if clear_readonly(&self.target_path) {
                fs::rename(&self.temp_path, &self.target_path)?;
            } else {
                return Err(error.into());
            }
        }
        Ok(())
    }

    pub fn discard(&self) {
        let _ = fs::remove_file(&self.temp_path);
    }
}

/// Clear a file's read-only attribute. Returns true only when it was set and is
/// now cleared, so the caller retries the rename exactly once. Windows only: on
/// POSIX a file in a writable directory can be replaced regardless, so the rename
/// never fails for this reason and the retry is never needed.
#[cfg(windows)]
fn clear_readonly(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_READONLY};
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    // SAFETY: a NUL-terminated wide path; both calls only read it.
    unsafe {
        let attrs = GetFileAttributesW(wide.as_ptr());
        if attrs == u32::MAX || attrs & FILE_ATTRIBUTE_READONLY == 0 {
            return false;
        }
        SetFileAttributesW(wide.as_ptr(), attrs & !FILE_ATTRIBUTE_READONLY) != 0
    }
}

#[cfg(not(windows))]
fn clear_readonly(_path: &Path) -> bool {
    false
}

/// Receive a file into `.reptile-<hex>.tmp` next to its destination, check the
/// byte count and stamp the sender's mtime on it. Nothing at the target path
/// changes until `commit`, which is an atomic rename on the same filesystem.
pub fn stage_file(
    root: &Path,
    wire_path: &str,
    source: &mut dyn Read,
    size: Option<u64>,
    mtime_ms: i64,
) -> FsResult<Staged> {
    let target_path = resolve_safely(root, wire_path)?;
    let directory = target_path.parent().map(Path::to_path_buf).unwrap_or_else(|| root.to_path_buf());
    let temp_path = directory.join(temp_name());
    let staged = Staged { state: State::file(0, 0), temp_path, target_path, wire_path: wire_path.to_string() };
    let result = (|| -> FsResult<State> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&staged.temp_path)?;
        let written = copy(source, &mut file)?;
        drop(file);
        if let Some(expected) = size {
            if written != expected {
                return Err(code("size_mismatch", format!("Expected {expected} bytes but received {written}.")));
            }
        }
        set_times(&staged.temp_path, mtime_ms)?;
        read_state(&staged.temp_path)?.ok_or_else(|| code("conflict", "The received file vanished."))
    })();
    match result {
        Ok(state) => Ok(Staged { state, ..staged }),
        Err(error) => {
            staged.discard();
            Err(error)
        }
    }
}

/// Copy with a buffer large enough for fast local disks.
fn copy(source: &mut dyn Read, destination: &mut File) -> io::Result<u64> {
    let mut buffer = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        let read = match source.read(&mut buffer) {
            Ok(0) => return Ok(total),
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        destination.write_all(&buffer[..read])?;
        total += read as u64;
    }
}

/// Delete one file. A file that is already gone is not an error.
pub fn remove_file(root: &Path, wire_path: &str) -> FsResult<bool> {
    let target = resolve_safely(root, wire_path)?;
    match fs::remove_file(&target) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => {
            if read_state_lossy(&target).map(|s| s.kind) == Some(Kind::Dir) {
                return Err(code("conflict", format!("{wire_path} is a directory.")));
            }
            Err(error.into())
        }
    }
}

/// Remove a directory tree, but only the entries `should_remove` approves.
///
/// Works bottom-up: files first, then each directory once it is empty. A
/// directory that still holds something (an unshared item, a file modified
/// since the peer last saw it, a symlink) is kept, and so are its ancestors.
pub fn remove_tree(
    root: &Path,
    wire_path: &str,
    should_remove: &mut dyn FnMut(&str, &State) -> bool,
) -> FsResult<(Vec<String>, Vec<String>)> {
    let mut removed = Vec::new();
    let mut kept = Vec::new();
    let top = resolve_safely(root, wire_path)?;
    let Some(top_state) = read_state(&top)? else { return Ok((removed, kept)) };
    if top_state.kind != Kind::Dir {
        return Err(code("conflict", format!("{wire_path} is not a directory.")));
    }

    fn visit(
        root: &Path,
        wire_path: &str,
        should_remove: &mut dyn FnMut(&str, &State) -> bool,
        removed: &mut Vec<String>,
        kept: &mut Vec<String>,
    ) -> FsResult<bool> {
        let absolute = wire::resolve(root, wire_path).map_err(|message| code("unsafe_path", message))?;
        let names = match fs::read_dir(&absolute) {
            Ok(listing) => {
                listing.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>()
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
            Err(_) => {
                kept.push(wire_path.to_string());
                return Ok(false);
            }
        };
        let mut empty = true;
        for name in names {
            let child = join(wire_path, &name);
            let Some(state) = read_state(&absolute.join(&name))? else { continue };
            if is_temp_name(&name) || state.kind == Kind::Other {
                kept.push(child);
                empty = false;
                continue;
            }
            if state.kind == Kind::Dir {
                if !visit(root, &child, should_remove, removed, kept)? {
                    empty = false;
                }
                continue;
            }
            if should_remove(&child, &state) {
                match fs::remove_file(absolute.join(&name)) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
                removed.push(child);
            } else {
                kept.push(child);
                empty = false;
            }
        }
        let own = read_state(&absolute)?;
        let approved = match own {
            Some(state) => should_remove(wire_path, &state),
            None => true,
        };
        if !empty || !approved {
            if empty {
                kept.push(wire_path.to_string());
            }
            return Ok(false);
        }
        match fs::remove_dir(&absolute) {
            Ok(()) => {
                removed.push(wire_path.to_string());
                Ok(true)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
            Err(error)
                if error.kind() == io::ErrorKind::DirectoryNotEmpty || error.kind() == io::ErrorKind::AlreadyExists =>
            {
                kept.push(wire_path.to_string());
                Ok(false)
            }
            Err(error) => Err(error.into()),
        }
    }

    visit(root, wire_path, should_remove, &mut removed, &mut kept)?;
    Ok((removed, kept))
}

/// Rename a file or directory inside the root, creating the destination's
/// parents as needed. Returns the parent directories created.
pub fn move_entry(root: &Path, from: &str, to: &str) -> FsResult<Vec<(String, State)>> {
    let source = resolve_safely(root, from)?;
    let created = ensure_directory(root, parent_of(to))?;
    let target = resolve_safely(root, to)?;
    let Some(source_state) = read_state(&source)? else {
        return Err(code("not_found", format!("{from} does not exist.")));
    };
    if let Some(target_state) = read_state(&target)? {
        if target_state.kind == Kind::Dir || source_state.kind == Kind::Dir {
            return Err(code("conflict", format!("{to} already exists.")));
        }
    }
    fs::rename(&source, &target)?;
    Ok(created)
}

/// What moved (from, to) and what stayed behind.
pub type SelectiveMove = (Vec<(String, String)>, Vec<String>);

/// Move a directory's content entry by entry, leaving behind whatever
/// `can_move` refuses. The host uses this when a peer renames a directory
/// that also contains unshared items: those must not move. Everything else
/// moves, and the source directory is removed if it ends up empty.
pub fn move_tree_selective(
    root: &Path,
    from: &str,
    to: &str,
    can_move: &dyn Fn(&str, &State) -> bool,
) -> FsResult<SelectiveMove> {
    let mut moved = Vec::new();
    let mut kept = Vec::new();
    ensure_directory(root, to)?;

    fn visit(
        root: &Path,
        source_wire: &str,
        target_wire: &str,
        can_move: &dyn Fn(&str, &State) -> bool,
        moved: &mut Vec<(String, String)>,
        kept: &mut Vec<String>,
    ) -> FsResult<bool> {
        let absolute = wire::resolve(root, source_wire).map_err(|message| code("unsafe_path", message))?;
        let names: Vec<String> = fs::read_dir(&absolute)
            .map(|listing| {
                listing.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect()
            })
            .unwrap_or_default();
        let mut empty = true;
        for name in names {
            let child = join(source_wire, &name);
            let destination = join(target_wire, &name);
            let Some(state) = read_state(&absolute.join(&name))? else { continue };
            if state.kind == Kind::Other || is_temp_name(&name) || !can_move(&child, &state) {
                kept.push(child);
                empty = false;
                continue;
            }
            if state.kind == Kind::Dir {
                ensure_directory(root, &destination)?;
                if !visit(root, &child, &destination, can_move, moved, kept)? {
                    empty = false;
                }
                continue;
            }
            let destination_path = wire::resolve(root, &destination).map_err(|message| code("unsafe_path", message))?;
            if read_state(&destination_path)?.map(|s| s.kind) == Some(Kind::Dir) {
                kept.push(child);
                empty = false;
                continue;
            }
            fs::rename(absolute.join(&name), &destination_path)?;
            moved.push((child, destination));
        }
        if !empty {
            return Ok(false);
        }
        match fs::remove_dir(&absolute) {
            Ok(()) => Ok(true),
            Err(_) => {
                kept.push(source_wire.to_string());
                Ok(false)
            }
        }
    }

    visit(root, from, to, can_move, &mut moved, &mut kept)?;
    Ok((moved, kept))
}

/// Set a file's modification (and access) time; returns its new state.
pub fn set_mtime(root: &Path, wire_path: &str, mtime_ms: i64) -> FsResult<Option<State>> {
    let target = resolve_safely(root, wire_path)?;
    set_times(&target, mtime_ms)?;
    Ok(read_state(&target)?)
}

/// Delete temporary files left behind by an interrupted transfer. Safe
/// whenever no transfer is in flight, which is when hosting or syncing starts.
pub fn remove_stale_temp_files(root: &Path) -> usize {
    let mut count = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let Ok(listing) = fs::read_dir(&directory) else { continue };
        for entry in listing.filter_map(Result::ok) {
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file()
                && is_temp_name(&entry.file_name().to_string_lossy())
                && fs::remove_file(entry.path()).is_ok()
            {
                count += 1;
            }
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::ids::random_hex;

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("reptile-mutate-{}", random_hex(4)));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn stages_and_commits_with_the_senders_mtime() {
        let root = temp_root();
        let staged = stage_file(&root, "a/b/c.txt", &mut &b"hello"[..], Some(5), 1_600_000_000_123);
        // The parent does not exist yet: the caller ensures directories first.
        assert!(staged.is_err());
        ensure_directory(&root, "a/b").unwrap();
        let staged = stage_file(&root, "a/b/c.txt", &mut &b"hello"[..], Some(5), 1_600_000_000_123).unwrap();
        assert_eq!(staged.state.mtime_ms, 1_600_000_000_123);
        staged.commit().unwrap();
        let state = read_state(&root.join("a/b/c.txt")).unwrap().unwrap();
        assert_eq!((state.size, state.mtime_ms), (5, 1_600_000_000_123));
        let short = stage_file(&root, "a/x.txt", &mut &b"hey"[..], Some(5), 1);
        assert!(matches!(short, Err(FsError::Code("size_mismatch", _))));
        assert_eq!(remove_stale_temp_files(&root), 0);
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn commit_replaces_a_read_only_file() {
        // On Windows a read-only target makes the rename fail; commit must clear
        // the attribute and retry, or a read-only file would never be updated.
        let root = temp_root();
        let target = root.join("readme.txt");
        fs::write(&target, b"old").unwrap();
        let mut perms = fs::metadata(&target).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&target, perms).unwrap();

        let staged = stage_file(&root, "readme.txt", &mut &b"new content"[..], Some(11), 1_600_000_000_000).unwrap();
        staged.commit().unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new content");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn remove_tree_keeps_what_it_must() {
        let root = temp_root();
        ensure_directory(&root, "t/keep").unwrap();
        fs::write(root.join("t/a.txt"), "a").unwrap();
        fs::write(root.join("t/keep/secret.txt"), "s").unwrap();
        let (removed, kept) = remove_tree(&root, "t", &mut |wire, _| !wire.ends_with("secret.txt")).unwrap();
        assert!(removed.contains(&"t/a.txt".to_string()));
        assert!(kept.contains(&"t/keep/secret.txt".to_string()));
        assert!(root.join("t/keep/secret.txt").exists());
        assert!(!root.join("t/a.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_write_through_a_symlink() {
        let root = temp_root();
        let outside = temp_root();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let result = resolve_safely(&root, "link/file.txt");
        assert!(matches!(result, Err(FsError::Code("unsafe_path", _))));
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }
}
