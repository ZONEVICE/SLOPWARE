//! The state of one filesystem entry, as the synchronisation engine sees it.
//!
//! Only regular files and directories are synchronised. Symbolic links,
//! sockets, FIFOs and devices are `Kind::Other` and never cross the wire:
//! following a link could publish something outside the shared directory.
//!
//! Two states are "the same" when they have the same kind and, for files, the
//! same size and modification time. That is rsync's quick check, and it works
//! because the receiving side always sets the mtime of a file it writes to the
//! sender's mtime.

use crate::util::ids::random_hex;
#[cfg(not(windows))]
use crate::util::time::mtime_ms;
use serde_json::{json, Value};
use std::io;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    File,
    Dir,
    Other,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::File => "file",
            Kind::Dir => "dir",
            Kind::Other => "other",
        }
    }

    pub fn parse(text: &str) -> Option<Kind> {
        match text {
            "file" => Some(Kind::File),
            "dir" => Some(Kind::Dir),
            _ => None,
        }
    }
}

/// Device plus inode (the volume serial number and file id on Windows).
pub type Identity = (u64, u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct State {
    pub kind: Kind,
    /// Bytes; 0 for directories.
    pub size: u64,
    /// Modification time, rounded to whole milliseconds.
    pub mtime_ms: i64,
    /// Local only, never sent to a peer.
    pub id: Option<Identity>,
}

impl State {
    pub fn file(size: u64, mtime_ms: i64) -> State {
        State { kind: Kind::File, size, mtime_ms, id: None }
    }

    pub fn dir(mtime_ms: i64) -> State {
        State { kind: Kind::Dir, size: 0, mtime_ms, id: None }
    }

    pub fn is_syncable(&self) -> bool {
        self.kind != Kind::Other
    }

    /// The part of a state that is meaningful to a peer.
    pub fn public(&self) -> State {
        State {
            kind: self.kind,
            size: if self.kind == Kind::File { self.size } else { 0 },
            mtime_ms: self.mtime_ms,
            id: None,
        }
    }

    /// `{ kind, size, mtimeMs }`.
    pub fn to_json(&self) -> Value {
        json!({ "kind": self.kind.as_str(), "size": if self.kind == Kind::File { self.size } else { 0 }, "mtimeMs": self.mtime_ms })
    }

    /// Parse `{ kind, size, mtimeMs }` from a peer. Numbers follow
    /// JavaScript's `Number(x) || 0`.
    pub fn from_json(value: &Value) -> Option<State> {
        let kind = Kind::parse(value.get("kind")?.as_str()?)?;
        let size = number(value.get("size")).max(0.0) as u64;
        let mtime_ms = number(value.get("mtimeMs")) as i64;
        Some(State { kind, size: if kind == Kind::File { size } else { 0 }, mtime_ms, id: None })
    }
}

/// A JSON number (or numeric string) as JavaScript's `Number(x) || 0` reads it.
pub fn number(value: Option<&Value>) -> f64 {
    let parsed = match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    };
    if parsed.is_finite() {
        parsed
    } else {
        0.0
    }
}

/// Absent equals absent. Directories equal each other regardless of mtime,
/// which changes every time a child does and means nothing to a peer.
pub fn same_state(a: Option<&State>, b: Option<&State>) -> bool {
    let left = a.filter(|s| s.is_syncable());
    let right = b.filter(|s| s.is_syncable());
    match (left, right) {
        (None, None) => true,
        (Some(l), Some(r)) => {
            l.kind == r.kind && (l.kind == Kind::Dir || (l.size == r.size && l.mtime_ms == r.mtime_ms))
        }
        _ => false,
    }
}

/// Identity key of a state, when it has one.
pub fn identity_of(state: Option<&State>) -> Option<Identity> {
    state.and_then(|s| s.id)
}

// --- Temporary files ------------------------------------------------------------

/// True for the name (not path) of one of Reptile's own temporary files:
/// `.reptile-<8 to 32 hex digits>.tmp`.
pub fn is_temp_name(name: &str) -> bool {
    let Some(hex) = name.strip_prefix(".reptile-").and_then(|rest| rest.strip_suffix(".tmp")) else { return false };
    (8..=32).contains(&hex.len()) && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// True when the last segment of a wire path is a temporary file name.
pub fn is_temp_path(wire: &str) -> bool {
    is_temp_name(crate::util::wire::base_name(wire))
}

/// A fresh temporary file name.
pub fn temp_name() -> String {
    format!(".reptile-{}.tmp", random_hex(8))
}

/// Can the local filesystem store this wire path as-is? Linux holds any byte;
/// Windows cannot store a segment with a reserved character, a trailing dot or
/// space, or a reserved device base name (CON, AUX, COM1…). A peer there skips
/// such a path instead of retrying a download that can never succeed, or that
/// Windows would silently munge (e.g. "x." -> "x") into an endless round-trip.
///
/// Twin of `node/src/fs/entry.js::isOsRepresentable`: keep the rule identical so
/// a Rust and a Node peer on one OS skip exactly the same names.
pub fn is_os_representable(wire_path: &str) -> bool {
    #[cfg(windows)]
    {
        const RESERVED: [&str; 22] = [
            "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1",
            "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
        ];
        for segment in wire_path.split('/').filter(|segment| !segment.is_empty()) {
            if segment.ends_with('.') || segment.ends_with(' ') {
                return false;
            }
            if segment.bytes().any(|b| b < 0x20 || matches!(b, b'<' | b'>' | b':' | b'"' | b'\\' | b'|' | b'?' | b'*'))
            {
                return false;
            }
            let base = segment.split('.').next().unwrap_or(segment).to_ascii_lowercase();
            if RESERVED.contains(&base.as_str()) {
                return false;
            }
        }
        true
    }
    #[cfg(not(windows))]
    {
        let _ = wire_path;
        true
    }
}

// --- Reading states ---------------------------------------------------------------

fn absent(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory)
}

/// The state of a path without following symlinks; None when nothing is there.
pub fn read_state(path: &Path) -> io::Result<Option<State>> {
    match platform::lstat(path) {
        Ok(state) => Ok(Some(state)),
        Err(error) if absent(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

/// `read_state`, with errors read as "nothing there".
pub fn read_state_lossy(path: &Path) -> Option<State> {
    read_state(path).ok().flatten()
}

/// Every entry of one directory with its state, Reptile's temporary files
/// excluded. Entries that vanish while listing are simply left out.
pub fn read_dir_states(dir: &Path) -> io::Result<Vec<(String, State)>> {
    platform::read_dir_states(dir)
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    pub fn state_of(meta: &std::fs::Metadata) -> State {
        let kind = if meta.file_type().is_file() {
            Kind::File
        } else if meta.file_type().is_dir() {
            Kind::Dir
        } else {
            Kind::Other
        };
        let mtime = meta.modified().map(mtime_ms).unwrap_or(0);
        State {
            kind,
            size: if kind == Kind::File { meta.len() } else { 0 },
            mtime_ms: mtime,
            id: Some((meta.dev(), meta.ino())),
        }
    }

    pub fn lstat(path: &Path) -> io::Result<State> {
        std::fs::symlink_metadata(path).map(|meta| state_of(&meta))
    }

    pub fn read_dir_states(dir: &Path) -> io::Result<Vec<(String, State)>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            let Ok(entry) = entry else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_temp_name(&name) {
                continue;
            }
            match std::fs::symlink_metadata(entry.path()) {
                Ok(meta) => out.push((name, state_of(&meta))),
                Err(error) if absent(&error) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(out)
    }
}

#[cfg(windows)]
mod platform {
    //! Windows: one handle per lookup, like libuv, so that the file id (the
    //! inode equivalent that rename detection relies on) comes with the state.
    //! Directory listings use FileIdBothDirectoryInfo: one handle per
    //! directory instead of one per entry.
    use super::*;
    use crate::util::time::js_round;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileAttributeTagInfo, FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo,
        GetFileInformationByHandle, GetFileInformationByHandleEx, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_BOTH_DIR_INFO, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    const IO_REPARSE_TAG_SYMLINK: u32 = 0xA000_000C;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    const EPOCH_DIFFERENCE_100NS: i64 = 116_444_736_000_000_000;

    pub fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    /// FILETIME (100 ns since 1601) to whole milliseconds, Node's way.
    fn mtime_from_filetime(filetime: i64) -> i64 {
        let unix = filetime - EPOCH_DIFFERENCE_100NS;
        let seconds = unix.div_euclid(10_000_000) as f64;
        let nanos = (unix.rem_euclid(10_000_000) * 100) as f64;
        js_round(seconds * 1e3 + nanos / 1e6) as i64
    }

    fn kind_of(attributes: u32, reparse_tag: u32) -> Kind {
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            && (reparse_tag == IO_REPARSE_TAG_SYMLINK || reparse_tag == IO_REPARSE_TAG_MOUNT_POINT)
        {
            Kind::Other
        } else if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            Kind::Dir
        } else {
            Kind::File
        }
    }

    struct Handle(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: the handle came from CreateFileW and is closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn open(path: &Path, access: u32) -> io::Result<Handle> {
        let name = wide(path);
        // SAFETY: a NUL-terminated wide path; the handle is wrapped at once.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(Handle(handle))
    }

    pub fn lstat(path: &Path) -> io::Result<State> {
        let handle = open(path, FILE_READ_ATTRIBUTES)?;
        // SAFETY: plain information queries on an open handle.
        unsafe {
            let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
            if GetFileInformationByHandle(handle.0, &mut info) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut tag = 0u32;
            if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                let mut tag_info: FILE_ATTRIBUTE_TAG_INFO = std::mem::zeroed();
                if GetFileInformationByHandleEx(
                    handle.0,
                    FileAttributeTagInfo,
                    &mut tag_info as *mut _ as *mut core::ffi::c_void,
                    std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
                ) != 0
                {
                    tag = tag_info.ReparseTag;
                }
            }
            let kind = kind_of(info.dwFileAttributes, tag);
            let size = ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64;
            let filetime =
                ((info.ftLastWriteTime.dwHighDateTime as i64) << 32) | info.ftLastWriteTime.dwLowDateTime as i64;
            let index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
            Ok(State {
                kind,
                size: if kind == Kind::File { size } else { 0 },
                mtime_ms: mtime_from_filetime(filetime),
                id: Some((info.dwVolumeSerialNumber as u64, index)),
            })
        }
    }

    pub fn read_dir_states(dir: &Path) -> io::Result<Vec<(String, State)>> {
        let handle = open(dir, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)?;
        let mut out = Vec::new();
        // SAFETY: the buffer is 8-byte aligned and parsed within its length.
        unsafe {
            let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
            if GetFileInformationByHandle(handle.0, &mut info) == 0 {
                return Err(io::Error::last_os_error());
            }
            let volume = info.dwVolumeSerialNumber as u64;
            let mut buffer = vec![0u64; 8 * 1024];
            let bytes = buffer.len() * 8;
            let mut class = FileIdBothDirectoryRestartInfo;
            loop {
                let ok = GetFileInformationByHandleEx(
                    handle.0,
                    class,
                    buffer.as_mut_ptr() as *mut core::ffi::c_void,
                    bytes as u32,
                );
                class = FileIdBothDirectoryInfo;
                if ok == 0 {
                    if GetLastError() == ERROR_NO_MORE_FILES {
                        break;
                    }
                    return Err(io::Error::last_os_error());
                }
                let base = buffer.as_ptr() as *const u8;
                let mut offset = 0usize;
                loop {
                    let entry = &*(base.add(offset) as *const FILE_ID_BOTH_DIR_INFO);
                    let name_units =
                        std::slice::from_raw_parts(entry.FileName.as_ptr(), entry.FileNameLength as usize / 2);
                    let name = String::from_utf16_lossy(name_units);
                    if name != "." && name != ".." && !is_temp_name(&name) {
                        let kind = kind_of(entry.FileAttributes, entry.EaSize);
                        out.push((
                            name,
                            State {
                                kind,
                                size: if kind == Kind::File { entry.EndOfFile.max(0) as u64 } else { 0 },
                                mtime_ms: mtime_from_filetime(entry.LastWriteTime),
                                id: Some((volume, entry.FileId as u64)),
                            },
                        ));
                    }
                    if entry.NextEntryOffset == 0 {
                        break;
                    }
                    offset += entry.NextEntryOffset as usize;
                }
            }
        }
        Ok(out)
    }
}

#[cfg(not(any(unix, windows)))]
mod platform {
    use super::*;

    pub fn lstat(path: &Path) -> io::Result<State> {
        let meta = std::fs::symlink_metadata(path)?;
        let kind = if meta.is_file() {
            Kind::File
        } else if meta.is_dir() {
            Kind::Dir
        } else {
            Kind::Other
        };
        Ok(State { kind, size: meta.len(), mtime_ms: meta.modified().map(mtime_ms).unwrap_or(0), id: None })
    }

    pub fn read_dir_states(dir: &Path) -> io::Result<Vec<(String, State)>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir)?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_temp_name(&name) {
                if let Ok(state) = lstat(&entry.path()) {
                    out.push((name, state));
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_names() {
        assert!(is_temp_name(".reptile-0123abcd.tmp"));
        assert!(is_temp_name(&temp_name()));
        assert!(!is_temp_name(".reptile-0123ABCD.tmp"));
        assert!(!is_temp_name(".reptile-0123.tmp"));
        assert!(!is_temp_name("reptile-0123abcd.tmp"));
        assert!(is_temp_path("a/b/.reptile-0123abcd.tmp"));
    }

    #[test]
    fn os_representable_names() {
        // Plain names are storable everywhere.
        assert!(is_os_representable("docs/readme.txt"));
        assert!(is_os_representable("a/b/c.bin"));
        // Windows cannot store reserved chars/names, a trailing dot or a device name.
        let unstorable =
            ["weird/a:b.txt", "weird/what?.txt", "weird/pipe|name.txt", "weird/trailing.", "weird/aux.txt"];
        for path in unstorable {
            assert_eq!(is_os_representable(path), !cfg!(windows), "{path}");
        }
    }

    #[test]
    fn same_state_rules() {
        let a = State::file(3, 100);
        assert!(same_state(Some(&a), Some(&State::file(3, 100))));
        assert!(!same_state(Some(&a), Some(&State::file(3, 101))));
        assert!(same_state(Some(&State::dir(1)), Some(&State::dir(2))));
        assert!(same_state(None, None));
        let other = State { kind: Kind::Other, size: 0, mtime_ms: 0, id: None };
        assert!(same_state(Some(&other), None));
        assert!(!same_state(Some(&a), None));
    }

    #[test]
    fn reads_real_entries() {
        let dir = std::env::temp_dir().join(format!("reptile-entry-{}", random_hex(4)));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "abc").unwrap();
        std::fs::write(dir.join(temp_name()), "x").unwrap();
        let state = read_state(&dir.join("a.txt")).unwrap().unwrap();
        assert_eq!(state.kind, Kind::File);
        assert_eq!(state.size, 3);
        assert!(state.id.is_some());
        assert!(read_state(&dir.join("missing")).unwrap().is_none());
        assert!(read_state(&dir.join("a.txt").join("below")).unwrap().is_none());
        let mut names: Vec<String> = read_dir_states(&dir).unwrap().into_iter().map(|(n, _)| n).collect();
        names.sort();
        assert_eq!(names, vec!["a.txt", "sub"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn json_round_trip() {
        let state = State::from_json(&json!({ "kind": "file", "size": 5, "mtimeMs": 1234 })).unwrap();
        assert_eq!(state, State::file(5, 1234));
        assert_eq!(state.to_json(), json!({ "kind": "file", "size": 5, "mtimeMs": 1234 }));
        assert!(State::from_json(&json!({ "kind": "link" })).is_none());
    }
}
