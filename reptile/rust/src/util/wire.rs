//! Wire paths: how a file inside a synced directory is named between instances.
//!
//! A wire path is relative to the synced root, uses "/" as the separator on
//! every platform, and has no leading or trailing slash. The root itself is the
//! empty string "". Examples: "notes.txt", "photos/2024/beach.jpg".
//!
//! Every path that arrives from the network goes through `normalize` before it
//! touches the disk, and `resolve` re-checks containment after joining.
//! Together they make "../../etc/passwd" impossible to express.

use std::path::{Component, Path, PathBuf};

/// Characters Windows cannot store in a name. Refusing them keeps a tree
/// portable to a Windows peer instead of failing halfway through a sync.
const WINDOWS_FORBIDDEN: &[char] = &['\\', ':', '*', '?', '"', '<', '>', '|'];

/// Validate and canonicalise a wire path. Returns None when it is not
/// acceptable; `allow_root` says whether "" (the root) is.
pub fn normalize(input: &str, allow_root: bool) -> Option<String> {
    if input.contains('\0') {
        return None;
    }
    // Tolerate leading/trailing slashes from sloppy callers, nothing more.
    let trimmed = input.trim_start_matches('/').trim_end_matches('/');
    if trimmed.is_empty() {
        return if allow_root { Some(String::new()) } else { None };
    }
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return None;
        }
        if cfg!(windows) && segment.contains(WINDOWS_FORBIDDEN) {
            return None;
        }
    }
    Some(trimmed.to_string())
}

/// Join a normalised wire path onto a root and verify the result stays inside
/// it. Symlinks inside the tree are handled separately by `fs::mutate`.
pub fn resolve(root: &Path, wire: &str) -> Result<PathBuf, String> {
    let mut full = root.to_path_buf();
    if wire.is_empty() {
        return Ok(full);
    }
    for segment in wire.split('/') {
        let mut components = Path::new(segment).components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(_)), None) => full.push(segment),
            _ => return Err(format!("Path escapes the synced directory: {wire}")),
        }
    }
    Ok(full)
}

/// Wire path of a path inside `root` (None when it is outside).
pub fn wire_of(root: &Path, absolute: &Path) -> Option<String> {
    let relative = absolute.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(name) => parts.push(name.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// Parent of a wire path; the parent of a top-level entry is "".
pub fn parent_of(wire: &str) -> &str {
    match wire.rfind('/') {
        Some(index) => &wire[..index],
        None => "",
    }
}

/// Last segment of a wire path.
pub fn base_name(wire: &str) -> &str {
    match wire.rfind('/') {
        Some(index) => &wire[index + 1..],
        None => wire,
    }
}

/// Number of segments; the root has depth 0.
pub fn depth_of(wire: &str) -> usize {
    if wire.is_empty() {
        0
    } else {
        wire.matches('/').count() + 1
    }
}

/// Join two wire paths.
pub fn join(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_string()
    } else if child.is_empty() {
        parent.to_string()
    } else {
        format!("{parent}/{child}")
    }
}

/// True when `child` is `parent` itself or lies below it.
pub fn is_same_or_inside(parent: &str, child: &str) -> bool {
    parent.is_empty() || child == parent || is_strictly_inside(parent, child)
}

/// True when `child` lies strictly below `parent`.
pub fn is_strictly_inside(parent: &str, child: &str) -> bool {
    if parent.is_empty() {
        return !child.is_empty();
    }
    child.len() > parent.len() && child.starts_with(parent) && child.as_bytes()[parent.len()] == b'/'
}

/// Replace the `from` prefix of `path` with `to`: `rebase("a/b/c", "a/b", "x")` is "x/c".
pub fn rebase(path: &str, from: &str, to: &str) -> String {
    if path == from {
        return to.to_string();
    }
    if from.is_empty() {
        return join(to, path);
    }
    join(to, &path[from.len() + 1..])
}

/// Sort so that every parent precedes its children and siblings stay together.
///
/// Comparing with "/" mapped to NUL (which sorts before every other
/// character) gives that order with one plain comparison per pair; a flat
/// string comparison would put "a-b" between "a" and "a/b".
pub fn sort_paths<I, S>(paths: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut keyed: Vec<(Vec<u8>, String)> = paths
        .into_iter()
        .map(|path| {
            let path: String = path.into();
            let key = path.bytes().map(|b| if b == b'/' { 0 } else { b }).collect();
            (key, path)
        })
        .collect();
    keyed.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    keyed.into_iter().map(|(_, path)| path).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization() {
        assert_eq!(normalize("a/b", false).as_deref(), Some("a/b"));
        assert_eq!(normalize("/a/b/", false).as_deref(), Some("a/b"));
        assert_eq!(normalize("", false), None);
        assert_eq!(normalize("", true).as_deref(), Some(""));
        assert_eq!(normalize("a//b", false), None);
        assert_eq!(normalize("a/../b", false), None);
        assert_eq!(normalize("./a", false), None);
        assert_eq!(normalize("a\0b", false), None);
    }

    #[test]
    fn helpers() {
        assert_eq!(parent_of("a/b/c"), "a/b");
        assert_eq!(parent_of("a"), "");
        assert_eq!(base_name("a/b/c"), "c");
        assert_eq!(depth_of(""), 0);
        assert_eq!(depth_of("a/b"), 2);
        assert!(is_strictly_inside("a", "a/b"));
        assert!(!is_strictly_inside("a", "ab"));
        assert!(!is_strictly_inside("a", "a"));
        assert!(is_same_or_inside("a", "a"));
        assert!(is_strictly_inside("", "x"));
        assert_eq!(rebase("a/b/c", "a/b", "x"), "x/c");
        assert_eq!(rebase("a/b", "a/b", "x"), "x");
    }

    #[test]
    fn parents_sort_before_children() {
        let sorted = sort_paths(["a-b", "a/b", "a", "b", "a/b/c"]);
        assert_eq!(sorted, vec!["a", "a/b", "a/b/c", "a-b", "b"]);
    }

    #[test]
    fn resolve_stays_inside() {
        let root = Path::new("/tmp/root");
        assert_eq!(resolve(root, "a/b").unwrap(), Path::new("/tmp/root/a/b"));
        assert_eq!(resolve(root, "").unwrap(), root);
        assert!(resolve(root, "..").is_err());
        assert_eq!(wire_of(root, Path::new("/tmp/root/a/b")).as_deref(), Some("a/b"));
        assert_eq!(wire_of(root, Path::new("/tmp/other")), None);
    }
}
