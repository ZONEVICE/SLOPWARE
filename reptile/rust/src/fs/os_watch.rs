//! Change hints from the operating system.
//!
//! This module only answers "which paths may have changed?". It never reads
//! file states and never decides anything: `fs::watcher` lstat's every hinted
//! path and diffs it against the index. A hint costs a string join and a
//! channel send.
//!
//! Two shapes, chosen per platform (the same design as the Node.js
//! implementation's `src/fs/dirWatch.js`):
//!
//!  - Linux: one inotify watch per directory. New directories are added by the
//!    owner as it discovers them (`add`), vanished ones released (`remove`).
//!    The inside of an unshared directory is never watched, but its parent is,
//!    so renaming the unshared directory itself is still seen.
//!  - Windows: ONE recursive ReadDirectoryChangesW on the root. A handle open
//!    on a subdirectory would stop the user from renaming its parent, so one
//!    handle on the root is also the polite choice there.
//!  - Anything else: no notifications; the watcher falls back to frequent full
//!    rescans.

use crate::util::threads::Locked;
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;

/// What the operating system reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hint {
    /// This wire path may have changed.
    Path(String),
    /// Something changed in this directory, but not which entry.
    Directory(String),
    /// The kernel dropped notifications: compare everything.
    Overflow,
}

pub use platform::OsWatch;

fn absolute(root: &Path, wire: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    if !wire.is_empty() {
        for segment in wire.split('/') {
            path.push(segment);
        }
    }
    path
}

/// Shared by the backends: walk the tree breadth-first, adding a watch to every
/// watchable directory BEFORE listing it, so nothing created meanwhile is lost.
#[allow(dead_code)]
fn watch_tree(
    root: &Path,
    watchable: &dyn Fn(&str) -> bool,
    add: &mut dyn FnMut(&str) -> io::Result<bool>,
) -> Vec<io::Error> {
    let mut errors = Vec::new();
    let mut queue = vec![String::new()];
    while let Some(dir) = queue.pop() {
        if !dir.is_empty() && !watchable(&dir) {
            continue;
        }
        match add(&dir) {
            Ok(_) => {}
            Err(error) => {
                errors.push(error);
                if !dir.is_empty() {
                    continue;
                }
            }
        }
        let Ok(listing) = std::fs::read_dir(absolute(root, &dir)) else { continue };
        for entry in listing.filter_map(Result::ok) {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                queue.push(crate::util::wire::join(&dir, &entry.file_name().to_string_lossy()));
            }
        }
    }
    errors
}

/// Errors meaning "that directory is gone", not "watching is broken".
pub fn vanished(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory | io::ErrorKind::PermissionDenied)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod platform {
    use super::*;
    use crate::fs::entry::is_temp_name;
    use crate::util::wire::{join, parent_of};
    use std::collections::HashMap;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;

    const MASK: u32 = libc::IN_MODIFY
        | libc::IN_ATTRIB
        | libc::IN_CLOSE_WRITE
        | libc::IN_MOVED_FROM
        | libc::IN_MOVED_TO
        | libc::IN_CREATE
        | libc::IN_DELETE
        | libc::IN_DELETE_SELF
        | libc::IN_MOVE_SELF
        | libc::IN_ONLYDIR
        | libc::IN_DONT_FOLLOW
        | libc::IN_EXCL_UNLINK;

    #[derive(Default)]
    struct Maps {
        by_wd: HashMap<i32, String>,
        by_path: HashMap<String, i32>,
    }

    struct Shared {
        fd: i32,
        root: PathBuf,
        maps: Mutex<Maps>,
        closed: AtomicBool,
    }

    pub struct OsWatch {
        shared: Arc<Shared>,
        reader: Mutex<Option<JoinHandle<()>>>,
    }

    impl OsWatch {
        /// Watch every watchable directory of the tree; hints go to `sink`.
        pub fn start(
            root: &Path,
            watchable: &dyn Fn(&str) -> bool,
            sink: Sender<Hint>,
        ) -> io::Result<(OsWatch, Vec<io::Error>)> {
            // SAFETY: a plain syscall; the descriptor is owned by `Shared`.
            let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            let shared = Arc::new(Shared {
                fd,
                root: root.to_path_buf(),
                maps: Mutex::new(Maps::default()),
                closed: AtomicBool::new(false),
            });
            let watch = OsWatch { shared: shared.clone(), reader: Mutex::new(None) };
            let errors = watch_tree(root, watchable, &mut |dir| watch.add(dir));
            let reader = std::thread::Builder::new().name("inotify".into()).spawn(move || read_loop(&shared, &sink))?;
            *watch.reader.locked() = Some(reader);
            Ok((watch, errors))
        }

        pub fn recursive(&self) -> bool {
            false
        }

        /// Watch one directory. Ok(true) when a NEW watch was created: the
        /// owner should then look inside the directory, since whatever was
        /// created there before the watch existed produced no event.
        pub fn add(&self, dir: &str) -> io::Result<bool> {
            if self.shared.closed.load(Ordering::SeqCst) {
                return Ok(false);
            }
            let path = absolute(&self.shared.root, dir);
            let c_path = CString::new(path.as_os_str().as_bytes()).map_err(io::Error::other)?;
            // SAFETY: valid descriptor and NUL-terminated path.
            let wd = unsafe { libc::inotify_add_watch(self.shared.fd, c_path.as_ptr(), MASK) };
            if wd < 0 {
                return Err(io::Error::last_os_error());
            }
            let mut maps = self.shared.maps.locked();
            if maps.by_path.get(dir) == Some(&wd) {
                return Ok(false);
            }
            // The kernel hands back the existing watch for the same inode: a
            // renamed directory keeps its watch, which now belongs here.
            if let Some(previous) = maps.by_wd.insert(wd, dir.to_string()) {
                if previous != dir && maps.by_path.get(&previous) == Some(&wd) {
                    maps.by_path.remove(&previous);
                }
            }
            maps.by_path.insert(dir.to_string(), wd);
            Ok(true)
        }

        pub fn has(&self, dir: &str) -> bool {
            self.shared.maps.locked().by_path.contains_key(dir)
        }

        pub fn size(&self) -> usize {
            self.shared.maps.locked().by_path.len()
        }

        /// Stop watching these directories and everything below them.
        pub fn remove(&self, dirs: &[String]) {
            if dirs.is_empty() {
                return;
            }
            let gone: HashSet<&str> = dirs.iter().map(String::as_str).collect();
            self.drop_where(|path| {
                let mut current = path;
                loop {
                    if gone.contains(current) {
                        return true;
                    }
                    if current.is_empty() {
                        return false;
                    }
                    current = parent_of(current);
                }
            });
        }

        /// Release every watch whose directory is not in `keep` (the root stays).
        pub fn retain(&self, keep: &HashSet<String>) {
            self.drop_where(|path| !path.is_empty() && !keep.contains(path));
        }

        fn drop_where(&self, condemned: impl Fn(&str) -> bool) {
            let mut maps = self.shared.maps.locked();
            let doomed: Vec<(String, i32)> =
                maps.by_path.iter().filter(|(path, _)| condemned(path)).map(|(p, wd)| (p.clone(), *wd)).collect();
            for (path, wd) in doomed {
                maps.by_path.remove(&path);
                if maps.by_wd.get(&wd) == Some(&path) {
                    maps.by_wd.remove(&wd);
                    // SAFETY: plain syscall on our own descriptor.
                    unsafe { libc::inotify_rm_watch(self.shared.fd, wd) };
                }
            }
        }

        pub fn close(&self) {
            if self.shared.closed.swap(true, Ordering::SeqCst) {
                return;
            }
            if let Some(reader) = self.reader.locked().take() {
                let _ = reader.join();
            }
            // SAFETY: the reader has exited; nothing else uses the descriptor.
            unsafe { libc::close(self.shared.fd) };
        }
    }

    impl Drop for OsWatch {
        fn drop(&mut self) {
            self.close();
        }
    }

    fn read_loop(shared: &Shared, sink: &Sender<Hint>) {
        let mut buffer = vec![0u8; 64 * 1024];
        let header = std::mem::size_of::<libc::inotify_event>();
        while !shared.closed.load(Ordering::SeqCst) {
            let mut poll = libc::pollfd { fd: shared.fd, events: libc::POLLIN, revents: 0 };
            // SAFETY: one valid pollfd.
            let ready = unsafe { libc::poll(&mut poll, 1, 200) };
            if ready <= 0 {
                continue;
            }
            // SAFETY: reading into our own buffer.
            let length = unsafe { libc::read(shared.fd, buffer.as_mut_ptr() as *mut libc::c_void, buffer.len()) };
            if length <= 0 {
                continue;
            }
            let mut offset = 0usize;
            let mut hints = Vec::new();
            while offset + header <= length as usize {
                // SAFETY: the kernel writes whole events; read the header unaligned.
                let event: libc::inotify_event =
                    unsafe { std::ptr::read_unaligned(buffer.as_ptr().add(offset) as *const _) };
                let name_bytes = &buffer[offset + header..offset + header + event.len as usize];
                offset += header + event.len as usize;
                if event.mask & libc::IN_Q_OVERFLOW != 0 {
                    hints.push(Hint::Overflow);
                    continue;
                }
                let mut maps = shared.maps.locked();
                if event.mask & libc::IN_IGNORED != 0 {
                    if let Some(path) = maps.by_wd.remove(&event.wd) {
                        if maps.by_path.get(&path) == Some(&event.wd) {
                            maps.by_path.remove(&path);
                        }
                    }
                    continue;
                }
                let Some(dir) = maps.by_wd.get(&event.wd).cloned() else { continue };
                drop(maps);
                let end = name_bytes.iter().position(|b| *b == 0).unwrap_or(name_bytes.len());
                if end > 0 {
                    let name = String::from_utf8_lossy(&name_bytes[..end]);
                    if !is_temp_name(&name) {
                        hints.push(Hint::Path(join(&dir, &name)));
                    }
                } else if dir.is_empty() {
                    // The root itself was deleted, moved or changed.
                    hints.push(Hint::Directory(String::new()));
                } else {
                    // An event about the watched directory itself.
                    hints.push(Hint::Path(dir));
                }
            }
            for hint in hints {
                if sink.send(hint).is_err() {
                    return;
                }
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use crate::fs::entry::is_temp_name;
    use std::os::windows::ffi::OsStrExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::thread::JoinHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY,
        FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_CREATION, FILE_NOTIFY_CHANGE_DIR_NAME,
        FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE, FILE_NOTIFY_INFORMATION,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::IO::CancelIoEx;

    struct Handle(HANDLE);
    // SAFETY: a directory handle may be used from any thread.
    unsafe impl Send for Handle {}
    unsafe impl Sync for Handle {}

    pub struct OsWatch {
        handle: std::sync::Arc<Handle>,
        closed: std::sync::Arc<AtomicBool>,
        reader: Mutex<Option<JoinHandle<()>>>,
    }

    impl OsWatch {
        pub fn start(
            root: &Path,
            _watchable: &dyn Fn(&str) -> bool,
            sink: Sender<Hint>,
        ) -> io::Result<(OsWatch, Vec<io::Error>)> {
            let wide: Vec<u16> = root.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
            // SAFETY: NUL-terminated wide path; the handle is owned below.
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    FILE_LIST_DIRECTORY,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS,
                    std::ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let handle = std::sync::Arc::new(Handle(handle));
            let closed = std::sync::Arc::new(AtomicBool::new(false));
            let (thread_handle, thread_closed) = (handle.clone(), closed.clone());
            // Wait until the reader thread is live and about to issue its first
            // ReadDirectoryChangesW, so a change made right after start() is not
            // lost while the thread waits to be scheduled (it was, under many
            // concurrent watchers in tests). inotify arms synchronously; here only
            // the instant between the signal and the call remains.
            let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
            let reader = std::thread::Builder::new()
                .name("rdcw".into())
                .spawn(move || read_loop(&thread_handle, &thread_closed, &sink, ready_tx))?;
            let _ = ready_rx.recv();
            Ok((OsWatch { handle, closed, reader: Mutex::new(Some(reader)) }, Vec::new()))
        }

        pub fn recursive(&self) -> bool {
            true
        }

        pub fn add(&self, _dir: &str) -> io::Result<bool> {
            Ok(false)
        }

        pub fn has(&self, _dir: &str) -> bool {
            !self.closed.load(Ordering::SeqCst)
        }

        pub fn size(&self) -> usize {
            1
        }

        pub fn remove(&self, _dirs: &[String]) {}

        pub fn retain(&self, _keep: &HashSet<String>) {}

        pub fn close(&self) {
            if self.closed.swap(true, Ordering::SeqCst) {
                return;
            }
            // SAFETY: cancels the blocking ReadDirectoryChangesW of the reader.
            unsafe { CancelIoEx(self.handle.0, std::ptr::null()) };
            if let Some(reader) = self.reader.locked().take() {
                let _ = reader.join();
            }
            // SAFETY: the reader has exited.
            unsafe { CloseHandle(self.handle.0) };
        }
    }

    impl Drop for OsWatch {
        fn drop(&mut self) {
            self.close();
        }
    }

    fn read_loop(handle: &Handle, closed: &AtomicBool, sink: &Sender<Hint>, ready: Sender<()>) {
        let mut buffer = vec![0u32; 16 * 1024];
        let filter = FILE_NOTIFY_CHANGE_FILE_NAME
            | FILE_NOTIFY_CHANGE_DIR_NAME
            | FILE_NOTIFY_CHANGE_ATTRIBUTES
            | FILE_NOTIFY_CHANGE_SIZE
            | FILE_NOTIFY_CHANGE_LAST_WRITE
            | FILE_NOTIFY_CHANGE_CREATION;
        // Unblock start(): the next statement is the first ReadDirectoryChangesW.
        let _ = ready.send(());
        while !closed.load(Ordering::SeqCst) {
            let mut returned = 0u32;
            // SAFETY: synchronous call into our DWORD-aligned buffer.
            let ok = unsafe {
                ReadDirectoryChangesW(
                    handle.0,
                    buffer.as_mut_ptr() as *mut core::ffi::c_void,
                    (buffer.len() * 4) as u32,
                    1,
                    filter,
                    &mut returned,
                    std::ptr::null_mut(),
                    None,
                )
            };
            if ok == 0 {
                if !closed.load(Ordering::SeqCst) {
                    // The root is gone or unreadable: let the batch find out.
                    let _ = sink.send(Hint::Directory(String::new()));
                }
                return;
            }
            if returned == 0 {
                if sink.send(Hint::Overflow).is_err() {
                    return;
                }
                continue;
            }
            let base = buffer.as_ptr() as *const u8;
            let mut offset = 0usize;
            loop {
                // SAFETY: entries lie within `returned` bytes, DWORD-aligned.
                let info = unsafe { &*(base.add(offset) as *const FILE_NOTIFY_INFORMATION) };
                let units =
                    unsafe { std::slice::from_raw_parts(info.FileName.as_ptr(), info.FileNameLength as usize / 2) };
                let relative = String::from_utf16_lossy(units).replace('\\', "/");
                let name = relative.rsplit('/').next().unwrap_or("");
                if !relative.is_empty() && !is_temp_name(name) && sink.send(Hint::Path(relative.clone())).is_err() {
                    return;
                }
                if info.NextEntryOffset == 0 {
                    break;
                }
                offset += info.NextEntryOffset as usize;
            }
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
mod platform {
    use super::*;

    /// No notifications on this platform: the watcher rescans instead.
    pub struct OsWatch;

    impl OsWatch {
        pub fn start(
            _root: &Path,
            _watchable: &dyn Fn(&str) -> bool,
            _sink: Sender<Hint>,
        ) -> io::Result<(OsWatch, Vec<io::Error>)> {
            Ok((OsWatch, Vec::new()))
        }
        pub fn recursive(&self) -> bool {
            true
        }
        pub fn add(&self, _dir: &str) -> io::Result<bool> {
            Ok(false)
        }
        pub fn has(&self, _dir: &str) -> bool {
            true
        }
        pub fn size(&self) -> usize {
            0
        }
        pub fn remove(&self, _dirs: &[String]) {}
        pub fn retain(&self, _keep: &HashSet<String>) {}
        pub fn close(&self) {}
    }
}

/// True when this platform delivers change notifications at all.
pub const NOTIFICATIONS: bool = cfg!(any(target_os = "linux", target_os = "android", windows));
