//! File operations inside a workspace.
//!
//! All functions are blocking (call them from `spawn_blocking`) and take a
//! [`Jail`]; none accepts an absolute path from the outside. Writes are atomic
//! (temporary file + rename) and keep the original file's permission bits, so
//! saving a shell script does not drop its executable bit. Saving checks the
//! modification time and size the browser saw when it opened the file and
//! refuses with [`FsError::Conflict`] if the file changed on disk meanwhile,
//! unless the user chose to overwrite.

use std::fs::{self, Metadata, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::jail::{self, Jail};
use super::text::{self, Decoded, Eol};
use super::{FsError, FsResult};
use crate::core::atomic::AtomicFile;
use crate::core::clock;

/// Entries returned by one directory listing at most.
pub const MAX_LIST_ENTRIES: usize = 10_000;

/// What an entry is, after following a symbolic link.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Dir,
    /// Broken links, links leaving the workspace, devices, sockets...
    Other,
}

/// One entry of a directory listing.
#[derive(Debug, Clone, Serialize)]
pub struct EntryInfo {
    pub name: String,
    pub kind: Kind,
    pub size: u64,
    /// Modification time, Unix milliseconds.
    pub mtime: u64,
    #[serde(skip_serializing_if = "is_false")]
    pub symlink: bool,
    /// A link whose target is missing or outside the workspace.
    #[serde(skip_serializing_if = "is_false")]
    pub unreachable: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub readonly: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub hidden: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Modification time and size: what conflict detection compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct FileMeta {
    pub mtime: u64,
    pub size: u64,
    pub readonly: bool,
}

impl FileMeta {
    /// From file metadata.
    pub fn of(meta: &Metadata) -> FileMeta {
        FileMeta { mtime: mtime_ms(meta), size: meta.len(), readonly: meta.permissions().readonly() }
    }
}

/// Modification time in Unix milliseconds (0 when unknown).
pub fn mtime_ms(meta: &Metadata) -> u64 {
    meta.modified().map(clock::system_time_ms).unwrap_or(0)
}

/// The state of a file the browser expects to overwrite.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Expected {
    pub mtime: u64,
    pub size: u64,
}

fn is_hidden(name: &str, meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0 {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = meta;
    name.starts_with('.')
}

/// Describes the entry at `path` (not following a final symlink first).
fn describe(jail: &Jail, name: String, path: &Path) -> FsResult<EntryInfo> {
    let link_meta = fs::symlink_metadata(path)?;
    let symlink = link_meta.file_type().is_symlink();
    let hidden = is_hidden(&name, &link_meta);
    let (meta, unreachable) = if symlink {
        match fs::canonicalize(path) {
            Ok(target) if jail.contains(&target) => match fs::metadata(&target) {
                Ok(meta) => (meta, false),
                Err(_) => (link_meta, true),
            },
            _ => (link_meta, true),
        }
    } else {
        (link_meta, false)
    };
    let kind = if unreachable {
        Kind::Other
    } else if meta.is_dir() {
        Kind::Dir
    } else if meta.is_file() {
        Kind::File
    } else {
        Kind::Other
    };
    Ok(EntryInfo {
        name,
        kind,
        size: if kind == Kind::File { meta.len() } else { 0 },
        mtime: mtime_ms(&meta),
        symlink,
        unreachable,
        readonly: meta.permissions().readonly(),
        hidden,
    })
}

/// Lists a directory: folders first, then files, case-insensitively by name.
/// Returns the entries and whether the listing was cut at [`MAX_LIST_ENTRIES`].
pub fn list(jail: &Jail, rel: &str) -> FsResult<(Vec<EntryInfo>, bool)> {
    let dir = jail.resolve(rel)?;
    if !fs::metadata(&dir)?.is_dir() {
        return Err(FsError::NotADirectory);
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(&dir)? {
        let Ok(entry) = entry else { continue };
        // Names that are not valid UTF-8 cannot round-trip through JSON paths.
        let Ok(name) = entry.file_name().into_string() else { continue };
        if entries.len() >= MAX_LIST_ENTRIES {
            truncated = true;
            break;
        }
        if let Ok(info) = describe(jail, name, &entry.path()) {
            entries.push(info);
        }
    }
    entries.sort_by(|a, b| {
        (a.kind != Kind::Dir)
            .cmp(&(b.kind != Kind::Dir))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok((entries, truncated))
}

/// Describes one entry (following symlinks inside the workspace).
pub fn stat(jail: &Jail, rel: &str) -> FsResult<EntryInfo> {
    let path = jail.entry(rel)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    describe(jail, name, &path)
}

/// Reads a text file for the editor, refusing files above `limit` bytes and
/// binary files.
pub fn read_text(jail: &Jail, rel: &str, limit: u64) -> FsResult<(Decoded, FileMeta)> {
    let path = jail.resolve(rel)?;
    let meta = fs::metadata(&path)?;
    if meta.is_dir() {
        return Err(FsError::IsADirectory);
    }
    if meta.len() > limit {
        return Err(FsError::TooLarge { size: meta.len(), limit });
    }
    let bytes = fs::read(&path)?;
    if bytes.len() as u64 > limit {
        return Err(FsError::TooLarge { size: bytes.len() as u64, limit });
    }
    let decoded = text::decode(bytes)?;
    Ok((decoded, FileMeta::of(&meta)))
}

/// Writes editor text atomically. `expected` is what the browser loaded
/// (`None` to skip the check, e.g. for "overwrite" or a brand new file).
/// Returns the new metadata and whether the file was created.
pub fn write_text(
    jail: &Jail,
    rel: &str,
    text: &str,
    eol: Eol,
    bom: bool,
    expected: Option<Expected>,
) -> FsResult<(FileMeta, bool)> {
    let (path, existing) = match jail.resolve(rel) {
        Ok(path) => {
            let meta = fs::metadata(&path)?;
            (path, Some(meta))
        }
        Err(FsError::NotFound) => (jail.target(rel)?, None),
        Err(err) => return Err(err),
    };
    if let Some(meta) = &existing {
        if meta.is_dir() {
            return Err(FsError::IsADirectory);
        }
        if meta.permissions().readonly() {
            return Err(FsError::ReadOnly);
        }
    }
    if let Some(expected) = expected {
        match &existing {
            Some(meta) if mtime_ms(meta) == expected.mtime && meta.len() == expected.size => {}
            Some(meta) => return Err(FsError::Conflict { mtime: mtime_ms(meta), size: meta.len(), exists: true }),
            None => return Err(FsError::Conflict { mtime: 0, size: 0, exists: false }),
        }
    }
    let bytes = text::encode(text, eol, bom);
    let mut file = AtomicFile::create(&path, false)?;
    file.file().write_all(&bytes)?;
    if let Some(meta) = &existing {
        keep_attributes(file.temp_path(), meta);
    }
    file.commit()?;
    let meta = fs::metadata(&path)?;
    Ok((FileMeta::of(&meta), existing.is_none()))
}

/// Copies permission bits (and, on Unix, ownership when allowed) from the
/// original file to its replacement.
pub fn keep_attributes(temp: &Path, original: &Metadata) {
    let _ = fs::set_permissions(temp, original.permissions());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = std::os::unix::fs::chown(temp, Some(original.uid()), Some(original.gid()));
    }
}

/// Creates an empty file or a folder.
pub fn create(jail: &Jail, rel: &str, dir: bool) -> FsResult<PathBuf> {
    let path = jail.target(rel)?;
    if fs::symlink_metadata(&path).is_ok() {
        return Err(FsError::AlreadyExists);
    }
    if dir {
        fs::create_dir(&path)?;
    } else {
        OpenOptions::new().write(true).create_new(true).open(&path)?;
    }
    Ok(path)
}

/// Renames or moves an entry. Refuses to replace an existing target unless
/// `overwrite` (and never replaces a folder), and refuses to move a folder
/// into itself. A case-only rename on a case-insensitive file system works.
pub fn rename(jail: &Jail, from: &str, to: &str, overwrite: bool) -> FsResult<(PathBuf, PathBuf)> {
    if Jail::is_root(from)? {
        return Err(FsError::InvalidPath("the workspace root cannot be moved".into()));
    }
    let src = jail.entry(from)?;
    let dst = jail.target(to)?;
    if src == dst {
        return Ok((src, dst));
    }
    if let Ok(existing) = fs::symlink_metadata(&dst) {
        let same_file = same_entry(&src, &dst);
        if !same_file && (!overwrite || existing.is_dir()) {
            return Err(FsError::AlreadyExists);
        }
    }
    refuse_into_itself(&src, &dst)?;
    match fs::rename(&src, &dst) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::CrossesDevices => {
            // A mount point inside the workspace: copy, then delete.
            copy_entry(&src, &dst)?;
            remove_entry(&src)?;
        }
        Err(err) => return Err(err.into()),
    }
    Ok((src, dst))
}

/// Copies a file or a folder (recursively). Symbolic links are copied as
/// links, never followed, so a copy cannot pull files in from outside.
pub fn copy(jail: &Jail, from: &str, to: &str) -> FsResult<(PathBuf, PathBuf)> {
    if Jail::is_root(from)? {
        return Err(FsError::InvalidPath("the workspace root cannot be copied".into()));
    }
    let src = jail.entry(from)?;
    let dst = jail.target(to)?;
    if fs::symlink_metadata(&dst).is_ok() {
        return Err(FsError::AlreadyExists);
    }
    refuse_into_itself(&src, &dst)?;
    copy_entry(&src, &dst)?;
    Ok((src, dst))
}

/// Copies an entry next to itself as `name copy.ext`, `name copy 2.ext`...
/// Returns the workspace-relative path of the copy.
pub fn duplicate(jail: &Jail, rel: &str) -> FsResult<String> {
    let src = jail.entry(rel)?;
    let parent = src.parent().ok_or(FsError::NotFound)?;
    let name = src.file_name().ok_or(FsError::NotFound)?.to_string_lossy().into_owned();
    let copy_name = unique_name(parent, &name, " copy")?;
    let parent_rel = jail.relative(parent).ok_or(FsError::Outside)?;
    let to = if parent_rel.is_empty() { copy_name } else { format!("{parent_rel}/{copy_name}") };
    copy(jail, rel, &to)?;
    Ok(to)
}

/// Deletes a file, link or folder (recursively). A symlink is removed, never
/// its target. The root cannot be deleted.
pub fn delete(jail: &Jail, rel: &str) -> FsResult<PathBuf> {
    if Jail::is_root(rel)? {
        return Err(FsError::InvalidPath("the workspace root cannot be deleted".into()));
    }
    let path = jail.entry(rel)?;
    remove_entry(&path)?;
    Ok(path)
}

/// A name based on `name` that does not exist in `dir`:
/// `a.txt` -> `a copy.txt`, `a copy 2.txt`, ... (`suffix` = `" copy"`).
pub fn unique_name(dir: &Path, name: &str, suffix: &str) -> FsResult<String> {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1..10_000 {
        let candidate = if n == 1 { format!("{stem}{suffix}{ext}") } else { format!("{stem}{suffix} {n}{ext}") };
        if fs::symlink_metadata(dir.join(&candidate)).is_err() {
            jail::validate_name(&candidate)?;
            return Ok(candidate);
        }
    }
    Err(FsError::AlreadyExists)
}

fn same_entry(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => jail::is_within(&x, &y) && jail::is_within(&y, &x),
        _ => false,
    }
}

/// Moving or copying `a/` into `a/b/` would recurse forever.
fn refuse_into_itself(src: &Path, dst: &Path) -> FsResult<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.is_dir()
        && let Some(parent) = dst.parent()
        && let Ok(src_canonical) = fs::canonicalize(src)
        && jail::is_within(&src_canonical, parent)
    {
        return Err(FsError::InvalidPath("a folder cannot be moved or copied into itself".into()));
    }
    Ok(())
}

fn copy_entry(src: &Path, dst: &Path) -> FsResult<()> {
    let meta = fs::symlink_metadata(src)?;
    let kind = meta.file_type();
    if kind.is_symlink() {
        copy_link(src, dst)
    } else if kind.is_dir() {
        fs::create_dir(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_entry(&entry.path(), &dst.join(entry.file_name()))?;
        }
        let _ = fs::set_permissions(dst, meta.permissions());
        Ok(())
    } else {
        fs::copy(src, dst)?;
        Ok(())
    }
}

#[cfg(unix)]
fn copy_link(src: &Path, dst: &Path) -> FsResult<()> {
    std::os::unix::fs::symlink(fs::read_link(src)?, dst)?;
    Ok(())
}

#[cfg(not(unix))]
fn copy_link(src: &Path, dst: &Path) -> FsResult<()> {
    // Creating links on Windows needs a privilege most users lack; links are
    // skipped rather than followed (following could import outside files).
    let _ = (src, dst);
    Ok(())
}

fn remove_entry(path: &Path) -> FsResult<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        fs::remove_dir_all(path)?;
        return Ok(());
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if cfg!(windows) && err.kind() == std::io::ErrorKind::PermissionDenied => {
            // Windows refuses to delete read-only files; Explorer clears the
            // attribute after confirmation, and so does Tendril.
            let mut perms = meta.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            fs::set_permissions(path, perms)?;
            fs::remove_file(path)?;
            Ok(())
        }
        Err(err) => Err(err.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::random;

    struct Ws {
        base: PathBuf,
        jail: Jail,
    }

    impl Ws {
        fn new() -> Ws {
            let base = std::env::temp_dir().join(format!("tendril-ops-{}", random::token_hex(4)));
            fs::create_dir_all(base.join("ws/src")).unwrap();
            fs::write(base.join("ws/src/main.rs"), "fn main() {}\n").unwrap();
            fs::write(base.join("ws/README.md"), "# hi\r\n").unwrap();
            let jail = Jail::new(&base.join("ws")).unwrap();
            Ws { base, jail }
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.base.join("ws").join(rel)
        }

        fn names(&self) -> Vec<String> {
            let mut names = Vec::new();
            for entry in fs::read_dir(self.path("")).unwrap() {
                names.push(entry.unwrap().file_name().to_string_lossy().into_owned());
            }
            names.sort();
            names
        }
    }

    impl Drop for Ws {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn lists_folders_first() {
        let ws = Ws::new();
        fs::write(ws.path(".env"), "X=1").unwrap();
        fs::create_dir(ws.path("assets")).unwrap();
        let (entries, truncated) = list(&ws.jail, "").unwrap();
        assert!(!truncated);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["assets", "src", ".env", "README.md"]);
        assert_eq!(entries[0].kind, Kind::Dir);
        assert!(entries[2].hidden);
        assert_eq!(entries[3].size, 6);
        assert!(matches!(list(&ws.jail, "README.md"), Err(FsError::NotADirectory)));
    }

    #[test]
    fn reads_and_writes_text_preserving_style() {
        let ws = Ws::new();
        let (doc, meta) = read_text(&ws.jail, "README.md", 1024).unwrap();
        assert_eq!(doc.text, "# hi\n");
        assert_eq!(doc.eol, Eol::Crlf);
        let expected = Expected { mtime: meta.mtime, size: meta.size };
        let (after, created) =
            write_text(&ws.jail, "README.md", "# hello\n", doc.eol, doc.bom, Some(expected)).unwrap();
        assert!(!created);
        assert_eq!(fs::read(ws.path("README.md")).unwrap(), b"# hello\r\n");
        assert_eq!(after.size, 9);
        // No temporary file left behind.
        assert_eq!(ws.names(), vec!["README.md", "src"]);
    }

    #[test]
    fn conflicts_are_detected() {
        let ws = Ws::new();
        let (_, meta) = read_text(&ws.jail, "src/main.rs", 1024).unwrap();
        // Someone else changes the file (different size).
        fs::write(ws.path("src/main.rs"), "fn main() { println!(); }\n").unwrap();
        let stale = Expected { mtime: meta.mtime, size: meta.size };
        let err = write_text(&ws.jail, "src/main.rs", "x", Eol::Lf, false, Some(stale)).unwrap_err();
        assert!(matches!(err, FsError::Conflict { exists: true, .. }));
        // Overwriting without the check works.
        write_text(&ws.jail, "src/main.rs", "x", Eol::Lf, false, None).unwrap();
        // A deleted file is a conflict too.
        fs::remove_file(ws.path("src/main.rs")).unwrap();
        let err = write_text(&ws.jail, "src/main.rs", "x", Eol::Lf, false, Some(stale)).unwrap_err();
        assert!(matches!(err, FsError::Conflict { exists: false, .. }));
    }

    #[test]
    fn limits_and_binary_files() {
        let ws = Ws::new();
        fs::write(ws.path("big.txt"), vec![b'a'; 2048]).unwrap();
        assert!(matches!(read_text(&ws.jail, "big.txt", 1024), Err(FsError::TooLarge { size: 2048, limit: 1024 })));
        fs::write(ws.path("image.png"), [0x89, b'P', b'N', b'G', 0, 0, 0]).unwrap();
        assert!(matches!(read_text(&ws.jail, "image.png", 1024), Err(FsError::Binary)));
        assert!(matches!(read_text(&ws.jail, "src", 1024), Err(FsError::IsADirectory)));
    }

    #[cfg(unix)]
    #[test]
    fn saving_keeps_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let ws = Ws::new();
        fs::write(ws.path("run.sh"), "#!/bin/sh\n").unwrap();
        fs::set_permissions(ws.path("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        write_text(&ws.jail, "run.sh", "#!/bin/sh\necho hi\n", Eol::Lf, false, None).unwrap();
        let mode = fs::metadata(ws.path("run.sh")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
    }

    #[test]
    fn read_only_files_are_not_overwritten() {
        let ws = Ws::new();
        let mut perms = fs::metadata(ws.path("README.md")).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(ws.path("README.md"), perms).unwrap();
        assert!(matches!(write_text(&ws.jail, "README.md", "x", Eol::Lf, false, None), Err(FsError::ReadOnly)));
        // Clean up so the fixture can be removed.
        let mut perms = fs::metadata(ws.path("README.md")).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(ws.path("README.md"), perms).unwrap();
    }

    #[test]
    fn create_rename_copy_duplicate_delete() {
        let ws = Ws::new();
        create(&ws.jail, "docs", true).unwrap();
        create(&ws.jail, "docs/a.txt", false).unwrap();
        assert!(matches!(create(&ws.jail, "docs/a.txt", false), Err(FsError::AlreadyExists)));

        rename(&ws.jail, "docs/a.txt", "docs/b.txt", false).unwrap();
        assert!(ws.path("docs/b.txt").exists() && !ws.path("docs/a.txt").exists());

        // Moving onto an existing file needs `overwrite`.
        assert!(matches!(rename(&ws.jail, "docs/b.txt", "README.md", false), Err(FsError::AlreadyExists)));
        // Moving a folder into itself is refused.
        assert!(matches!(rename(&ws.jail, "docs", "docs/inner", false), Err(FsError::InvalidPath(_))));
        assert!(matches!(copy(&ws.jail, "docs", "docs/inner",), Err(FsError::InvalidPath(_))));

        copy(&ws.jail, "src", "src2").unwrap();
        assert_eq!(fs::read_to_string(ws.path("src2/main.rs")).unwrap(), "fn main() {}\n");

        assert_eq!(duplicate(&ws.jail, "README.md").unwrap(), "README copy.md");
        assert_eq!(duplicate(&ws.jail, "README.md").unwrap(), "README copy 2.md");
        assert_eq!(duplicate(&ws.jail, "src/main.rs").unwrap(), "src/main copy.rs");
        assert_eq!(duplicate(&ws.jail, "docs").unwrap(), "docs copy");

        delete(&ws.jail, "src2").unwrap();
        assert!(!ws.path("src2").exists());
        assert!(matches!(delete(&ws.jail, ""), Err(FsError::InvalidPath(_))));
        assert!(matches!(delete(&ws.jail, "/"), Err(FsError::InvalidPath(_))));
        assert!(matches!(rename(&ws.jail, "", "x", false), Err(FsError::InvalidPath(_))));
    }

    #[cfg(unix)]
    #[test]
    fn deleting_a_link_keeps_its_target() {
        let ws = Ws::new();
        fs::create_dir(ws.base.join("outside")).unwrap();
        fs::write(ws.base.join("outside/keep.txt"), "keep").unwrap();
        std::os::unix::fs::symlink(ws.base.join("outside"), ws.path("link")).unwrap();
        let (entries, _) = list(&ws.jail, "").unwrap();
        let link = entries.iter().find(|e| e.name == "link").unwrap();
        assert!(link.symlink && link.unreachable);
        assert_eq!(link.kind, Kind::Other);
        delete(&ws.jail, "link").unwrap();
        assert!(ws.base.join("outside/keep.txt").exists());
    }

    #[test]
    fn unique_names() {
        let ws = Ws::new();
        assert_eq!(unique_name(&ws.path(""), ".gitignore", " copy").unwrap(), ".gitignore copy");
        assert_eq!(unique_name(&ws.path(""), "archive.tar.gz", " copy").unwrap(), "archive.tar copy.gz");
        assert_eq!(unique_name(&ws.path(""), "Makefile", " copy").unwrap(), "Makefile copy");
    }
}
