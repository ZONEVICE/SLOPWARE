//! Validation of the directories the user types into the interface.
//!
//! The interface calls these on every pause in typing, so the messages are
//! written for a person and each result says exactly one thing that is wrong,
//! or what will happen when the directory is used. The wording is the Node.js
//! implementation's, word for word.

use crate::fs::entry::is_temp_name;
use crate::util::sys::{access, real_path};
use serde_json::{json, Map, Value};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Default)]
pub struct PathCheck {
    pub ok: bool,
    pub code: &'static str,
    pub message: String,
    pub path: Option<String>,
    pub entries: Option<usize>,
    pub exists: Option<bool>,
    pub empty: Option<bool>,
}

impl PathCheck {
    fn fail(code: &'static str, message: impl Into<String>) -> PathCheck {
        PathCheck { ok: false, code, message: message.into(), ..Default::default() }
    }

    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("ok".into(), json!(self.ok));
        object.insert("code".into(), json!(self.code));
        if let Some(path) = &self.path {
            object.insert("path".into(), json!(path));
        }
        if let Some(exists) = self.exists {
            object.insert("exists".into(), json!(exists));
        }
        if let Some(empty) = self.empty {
            object.insert("empty".into(), json!(empty));
        }
        if let Some(entries) = self.entries {
            object.insert("entries".into(), json!(entries));
        }
        object.insert("message".into(), json!(self.message));
        Value::Object(object)
    }
}

fn permission(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
}

fn plural(count: usize, word: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { "s" })
}

fn count_entries(path: &Path) -> io::Result<usize> {
    Ok(fs::read_dir(path)?.filter_map(Result::ok).filter(|e| !is_temp_name(&e.file_name().to_string_lossy())).count())
}

/// `path.resolve`: absolute, with "." and ".." removed lexically.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if !out.pop() {
                    out.push(component);
                }
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// A directory the user wants to host: it must exist, be a directory, and
/// have readable contents.
pub fn check_host_directory(input: Option<&str>) -> PathCheck {
    let raw = input.map(str::trim).unwrap_or("");
    if raw.is_empty() {
        return PathCheck::fail("empty", "Type the absolute path of the directory to host.");
    }
    let raw_path = Path::new(raw);
    if !raw_path.is_absolute() {
        return PathCheck::fail(
            "not_absolute",
            "The path must be absolute, starting from the root (for example /home/you/Documents).",
        );
    }
    let info = match fs::metadata(raw_path) {
        Ok(info) => info,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return PathCheck::fail("not_found", "Nothing exists at this path.")
        }
        Err(error) if error.kind() == io::ErrorKind::NotADirectory => {
            return PathCheck::fail("not_found", "A parent of this path is a file, so the path cannot exist.")
        }
        Err(error) if permission(&error) => {
            return PathCheck::fail("permission", "Permission denied while looking up this path.")
        }
        Err(error) => return PathCheck::fail("error", error.to_string()),
    };
    if !info.is_dir() {
        return PathCheck::fail("not_directory", "This path is a file, not a directory.");
    }
    let canonical = real_path(raw_path).unwrap_or_else(|_| normalize(raw_path));
    let unreadable = || PathCheck {
        path: Some(text(&canonical)),
        ..PathCheck::fail("unreadable", "The directory exists, but its contents cannot be read (permission denied).")
    };
    if !access(&canonical, true, false, true) {
        return unreadable();
    }
    match count_entries(&canonical) {
        Ok(entries) => PathCheck {
            ok: true,
            code: "ok",
            path: Some(text(&canonical)),
            entries: Some(entries),
            message: if entries == 0 {
                "Readable directory. It is empty.".into()
            } else {
                format!("Readable directory with {} at the top level.", plural(entries, "item"))
            },
            ..Default::default()
        },
        Err(error) if permission(&error) => unreadable(),
        Err(error) => PathCheck { path: Some(text(&canonical)), ..PathCheck::fail("error", error.to_string()) },
    }
}

/// The local directory a synced copy will be written to. It may exist (and
/// must then be a writable directory) or be created (its nearest existing
/// parent must then be a writable directory).
pub fn check_sync_directory(input: Option<&str>) -> PathCheck {
    let raw = input.map(str::trim).unwrap_or("");
    if raw.is_empty() {
        return PathCheck::fail("empty", "Type the absolute path where the synced directory will be stored.");
    }
    let raw_path = Path::new(raw);
    if !raw_path.is_absolute() {
        return PathCheck::fail(
            "not_absolute",
            "The path must be absolute, starting from the root (for example /home/you/Synced).",
        );
    }
    let target = normalize(raw_path);
    if target.parent().is_none() {
        return PathCheck::fail("root", "The filesystem root cannot be used as a synced directory.");
    }

    let info = match fs::metadata(&target) {
        Ok(info) => Some(info),
        Err(error) if permission(&error) => {
            return PathCheck::fail("permission", "Permission denied while looking up this path.")
        }
        Err(error) if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) => None,
        Err(error) => return PathCheck::fail("error", error.to_string()),
    };

    if let Some(info) = info {
        if !info.is_dir() {
            return PathCheck::fail("not_directory", "This path is a file, not a directory.");
        }
        let canonical = real_path(&target).unwrap_or_else(|_| target.clone());
        if !access(&canonical, true, true, true) {
            return PathCheck {
                path: Some(text(&canonical)),
                ..PathCheck::fail("not_writable", "The directory exists, but you cannot write to it.")
            };
        }
        let Ok(entries) = count_entries(&canonical) else {
            return PathCheck {
                path: Some(text(&canonical)),
                ..PathCheck::fail("unreadable", "The directory exists, but its contents cannot be read.")
            };
        };
        return PathCheck {
            ok: true,
            code: if entries == 0 { "empty_directory" } else { "existing_directory" },
            path: Some(text(&canonical)),
            exists: Some(true),
            empty: Some(entries == 0),
            entries: Some(entries),
            message: if entries == 0 {
                "Empty directory. The host\u{2019}s files will be copied here.".into()
            } else {
                format!(
                    "Existing directory with {}. Its content will be merged with the host\u{2019}s: anything missing on either side is copied, and where both have a different version the newer one wins.",
                    plural(entries, "item")
                )
            },
        };
    }

    // Walk up to the nearest existing ancestor.
    let mut ancestor = target.parent().map(Path::to_path_buf).unwrap_or_else(|| target.clone());
    loop {
        match fs::metadata(&ancestor) {
            Ok(info) => {
                if !info.is_dir() {
                    return PathCheck::fail(
                        "parent_not_directory",
                        format!("{} is a file, so this directory cannot be created.", text(&ancestor)),
                    );
                }
                break;
            }
            Err(error) if permission(&error) => {
                return PathCheck::fail("permission", format!("Permission denied on {}.", text(&ancestor)))
            }
            Err(_) => match ancestor.parent() {
                Some(parent) => ancestor = parent.to_path_buf(),
                None => return PathCheck::fail("error", "No existing parent directory was found."),
            },
        }
    }
    if !access(&ancestor, false, true, true) {
        return PathCheck::fail(
            "not_writable",
            format!("The directory cannot be created: you cannot write to {}.", text(&ancestor)),
        );
    }
    let canonical_ancestor = real_path(&ancestor).unwrap_or_else(|_| ancestor.clone());
    let rest = target.strip_prefix(&ancestor).map(Path::to_path_buf).unwrap_or_default();
    let path = if rest.as_os_str().is_empty() { canonical_ancestor } else { canonical_ancestor.join(rest) };
    PathCheck {
        ok: true,
        code: "will_create",
        path: Some(text(&path)),
        exists: Some(false),
        empty: Some(true),
        entries: Some(0),
        message: "This directory does not exist yet. It will be created when the sync starts.".into(),
    }
}

/// True when one absolute path is the other or contains it. Used to refuse
/// syncing a directory into itself on the same machine.
pub fn paths_overlap(a: &str, b: &str) -> bool {
    let left = normalize(Path::new(a));
    let right = normalize(Path::new(b));
    left.starts_with(&right) || right.starts_with(&left)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap() {
        assert!(paths_overlap("/a/b", "/a/b"));
        assert!(paths_overlap("/a/b/c", "/a/b"));
        assert!(paths_overlap("/a", "/a/b"));
        assert!(!paths_overlap("/a/b", "/a/bc"));
        assert!(paths_overlap("/a/./b/../b", "/a/b"));
    }

    #[test]
    fn messages() {
        assert_eq!(check_host_directory(None).code, "empty");
        assert_eq!(check_host_directory(Some("relative/path")).code, "not_absolute");
        let missing = std::env::temp_dir().join("reptile-definitely-missing-dir");
        assert_eq!(check_host_directory(Some(&missing.to_string_lossy())).code, "not_found");
        let will = check_sync_directory(Some(&missing.join("child").to_string_lossy()));
        assert_eq!(will.code, "will_create");
        assert!(will.ok);
        let tmp = check_host_directory(Some(&std::env::temp_dir().to_string_lossy()));
        assert!(tmp.ok, "{}", tmp.message);
    }
}
