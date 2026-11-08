//! The folder picker shown after login: it browses the host's directory tree
//! from its root (`/` on Unix, the drive letters on Windows) so the user can
//! choose a workspace.
//!
//! It lists **folders only**, never files and never contents. Paths here are
//! absolute and opaque to the browser: it sends back exactly the strings this
//! module produced, so the browser never has to understand Windows paths.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::jail;
use super::{FsError, FsResult};

/// Folders listed per directory at most.
pub const MAX_DIRS: usize = 5_000;

/// One folder in a listing.
#[derive(Debug, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
}

/// A directory's subfolders.
#[derive(Debug, Serialize)]
pub struct Listing {
    /// The directory itself (display form).
    pub path: String,
    /// Its parent, `None` at a root.
    pub parent: Option<String>,
    /// Breadcrumbs from the root: (name, path).
    pub crumbs: Vec<(String, String)>,
    pub dirs: Vec<DirEntry>,
    pub truncated: bool,
}

/// The starting points: `/` on Unix, every drive on Windows.
pub fn roots() -> Vec<String> {
    #[cfg(windows)]
    {
        windows_drives()
    }
    #[cfg(not(windows))]
    {
        vec!["/".to_string()]
    }
}

#[cfg(windows)]
fn windows_drives() -> Vec<String> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLogicalDrives() -> u32;
    }
    // SAFETY: GetLogicalDrives takes no arguments and returns a bit mask.
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8).filter(|i| mask & (1 << i) != 0).map(|i| format!("{}:\\", (b'A' + i) as char)).collect()
}

/// Lists the subfolders of an absolute path.
pub fn list(path: &str) -> FsResult<Listing> {
    if path.contains('\0') {
        return Err(FsError::InvalidPath("the path contains a NUL character".into()));
    }
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err(FsError::InvalidPath("the path must be absolute".into()));
    }
    let dir = fs::canonicalize(&requested)?;
    if !fs::metadata(&dir)?.is_dir() {
        return Err(FsError::NotADirectory);
    }
    let mut dirs = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(&dir)? {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else { continue };
        let entry_path = entry.path();
        // Follow links: a link to a folder is a folder the user may pick.
        let Ok(meta) = fs::metadata(&entry_path) else { continue };
        if !meta.is_dir() {
            continue;
        }
        if dirs.len() >= MAX_DIRS {
            truncated = true;
            break;
        }
        let hidden = is_hidden(&name, &entry_path);
        dirs.push(DirEntry { name, path: jail::display(&entry_path), hidden });
    }
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
    Ok(Listing {
        path: jail::display(&dir),
        parent: dir.parent().map(jail::display),
        crumbs: crumbs(&dir),
        dirs,
        truncated,
    })
}

fn is_hidden(name: &str, path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if let Ok(meta) = fs::symlink_metadata(path)
            && meta.file_attributes() & 0x2 != 0
        {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = path;
    name.starts_with('.')
}

/// Breadcrumbs for a canonical directory.
fn crumbs(dir: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut current = Some(dir);
    while let Some(path) = current {
        let name = match path.file_name() {
            Some(name) => name.to_string_lossy().into_owned(),
            None => jail::display(path),
        };
        out.push((name, jail::display(path)));
        current = path.parent();
    }
    out.reverse();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::random;

    #[test]
    fn lists_only_folders() {
        let base = std::env::temp_dir().join(format!("tendril-picker-{}", random::token_hex(4)));
        fs::create_dir_all(base.join("b-dir")).unwrap();
        fs::create_dir_all(base.join("A-dir")).unwrap();
        fs::create_dir_all(base.join(".hidden")).unwrap();
        fs::write(base.join("file.txt"), "x").unwrap();
        let listing = list(&base.to_string_lossy()).unwrap();
        let names: Vec<&str> = listing.dirs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, vec![".hidden", "A-dir", "b-dir"]);
        assert!(listing.dirs[0].hidden);
        assert!(listing.parent.is_some());
        assert_eq!(listing.crumbs.last().unwrap().1, listing.path);
        assert!(matches!(list("relative/path"), Err(FsError::InvalidPath(_))));
        assert!(matches!(list(&base.join("file.txt").to_string_lossy()), Err(FsError::NotADirectory)));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn there_is_at_least_one_root() {
        let roots = roots();
        assert!(!roots.is_empty());
        for root in roots {
            assert!(list(&root).is_ok(), "{root}");
        }
    }
}
