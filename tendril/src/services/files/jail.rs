//! Confinement of every file operation to the workspace.
//!
//! The browser only ever sends **workspace-relative** paths (`src/main.rs`).
//! A [`Jail`] turns them into absolute paths and guarantees the result is
//! inside the workspace root:
//!
//! 1. The relative path is split on `/` (and `\` on Windows). Empty and `.`
//!    components are dropped; `..` is refused outright, as is NUL. A leading
//!    `/` is simply ignored: `/etc/passwd` means `<workspace>/etc/passwd`.
//! 2. On Windows a component may not contain `:` (drive letters, alternate
//!    data streams), the characters `<>"|?*`, control characters, a trailing
//!    dot or space, nor be a reserved device name (`CON`, `NUL`, `COM1`...).
//! 3. The joined path is canonicalized - which resolves symbolic links - and
//!    must still start with the canonical root (compared case-insensitively on
//!    Windows, where canonical paths carry the `\\?\` prefix). A symlink that
//!    points outside the workspace is therefore unusable.
//! 4. Operations on the entry itself (delete, rename, `lstat`) canonicalize the
//!    **parent** and keep the last component as is, so deleting a symlink
//!    removes the link, never its target.
//! 5. Paths that do not exist yet canonicalize the parent, which must exist
//!    inside the workspace, and validate the new name.
//!
//! Query strings are percent-decoded exactly once by the HTTP layer, so
//! `%2e%2e` arrives here as `..` (refused) and `%252e%252e` as the literal
//! name `%2e%2e` (harmless). A race where someone swaps a directory for a
//! symlink between the check and the use requires write access to the
//! workspace from another process, which is outside the threat model.

use std::fs;
use std::path::{Path, PathBuf};

use super::{FsError, FsResult};

/// A workspace root and the rules to stay inside it.
#[derive(Debug, Clone)]
pub struct Jail {
    root: PathBuf,
}

impl Jail {
    /// Opens a workspace at `path`, which must be an existing directory.
    pub fn new(path: &Path) -> FsResult<Jail> {
        let root = fs::canonicalize(path)?;
        if !fs::metadata(&root)?.is_dir() {
            return Err(FsError::NotADirectory);
        }
        Ok(Jail { root })
    }

    /// The canonical root (on Windows, with the `\\?\` prefix).
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The root as shown to people.
    pub fn display_root(&self) -> String {
        display(&self.root)
    }

    /// True when `abs` (already canonical) is the root or below it.
    pub fn contains(&self, abs: &Path) -> bool {
        is_within(&self.root, abs)
    }

    /// An existing path, following symbolic links, that must resolve inside
    /// the workspace. For reading and writing contents.
    pub fn resolve(&self, rel: &str) -> FsResult<PathBuf> {
        let joined = join(&self.root, &split(rel)?);
        let canonical = fs::canonicalize(&joined)?;
        if !self.contains(&canonical) {
            return Err(FsError::Outside);
        }
        Ok(canonical)
    }

    /// An existing entry **without** following a symlink in the last
    /// component. For delete, rename, copy sources and `lstat`.
    pub fn entry(&self, rel: &str) -> FsResult<PathBuf> {
        let parts = split(rel)?;
        let Some((name, parents)) = parts.split_last() else {
            return Ok(self.root.clone());
        };
        let parent = self.directory(parents)?;
        let path = parent.join(name);
        fs::symlink_metadata(&path)?;
        Ok(path)
    }

    /// A path for something that will be created: the parent must exist
    /// inside the workspace and the new name must be valid. Existence of the
    /// target itself is the caller's business.
    pub fn target(&self, rel: &str) -> FsResult<PathBuf> {
        let parts = split(rel)?;
        let Some((name, parents)) = parts.split_last() else {
            return Err(FsError::InvalidPath("the workspace root cannot be replaced".into()));
        };
        validate_name(name)?;
        let parent = self.directory(parents)?;
        Ok(parent.join(name))
    }

    /// True when `rel` designates the workspace root itself.
    pub fn is_root(rel: &str) -> FsResult<bool> {
        Ok(split(rel)?.is_empty())
    }

    /// The workspace-relative form (`a/b/c`) of an absolute path inside the
    /// workspace; `""` for the root.
    pub fn relative(&self, abs: &Path) -> Option<String> {
        if !self.contains(abs) {
            return None;
        }
        let depth = self.root.components().count();
        let parts: Vec<String> =
            abs.components().skip(depth).map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
        Some(parts.join("/"))
    }

    /// Canonical directory for a list of components, inside the workspace.
    fn directory(&self, parts: &[&str]) -> FsResult<PathBuf> {
        let canonical = fs::canonicalize(join(&self.root, parts))?;
        if !self.contains(&canonical) {
            return Err(FsError::Outside);
        }
        if !fs::metadata(&canonical)?.is_dir() {
            return Err(FsError::NotADirectory);
        }
        Ok(canonical)
    }
}

/// Splits a relative path into validated components.
pub fn split(rel: &str) -> FsResult<Vec<&str>> {
    if rel.contains('\0') {
        return Err(FsError::InvalidPath("the path contains a NUL character".into()));
    }
    let separators: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
    let mut parts = Vec::new();
    for part in rel.split(separators) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(FsError::Outside);
        }
        if cfg!(windows) {
            check_windows_component(part)?;
        }
        parts.push(part);
    }
    Ok(parts)
}

fn join(root: &Path, parts: &[&str]) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in parts {
        path.push(part);
    }
    path
}

/// Validates a name for a new file or folder.
pub fn validate_name(name: &str) -> FsResult<()> {
    let invalid = |why: &str| Err(FsError::InvalidPath(why.into()));
    if name.is_empty() || name.trim().is_empty() {
        return invalid("the name is empty");
    }
    if name == "." || name == ".." {
        return invalid("the name cannot be . or ..");
    }
    if name.len() > 255 {
        return invalid("the name is longer than 255 bytes");
    }
    if name.contains(['/', '\\', '\0']) {
        return invalid("the name cannot contain / or \\");
    }
    check_windows_component(name)
}

/// The Windows naming rules. Applied to new names on every OS (so a project
/// stays portable) and to every component of every path on Windows.
fn check_windows_component(part: &str) -> FsResult<()> {
    let invalid = |why: &str| Err(FsError::InvalidPath(why.into()));
    if part.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 32) {
        return invalid("the name contains a character Windows does not allow (< > : \" | ? * or a control character)");
    }
    if part.ends_with('.') || part.ends_with(' ') {
        return invalid("the name cannot end with a dot or a space");
    }
    let stem = part.split('.').next().unwrap_or(part).trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && ["¹", "²", "³"].iter().any(|s| stem.ends_with(s)));
    if reserved {
        return invalid("the name is reserved by Windows");
    }
    Ok(())
}

/// True when canonical `path` is `root` or inside it.
pub fn is_within(root: &Path, path: &Path) -> bool {
    #[cfg(windows)]
    {
        let lower = |p: &Path| -> Vec<String> {
            p.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect()
        };
        let (root, path) = (lower(root), lower(path));
        path.len() >= root.len() && path[..root.len()] == root[..]
    }
    #[cfg(not(windows))]
    {
        path.starts_with(root)
    }
}

/// A path as shown to people: without the Windows verbatim prefix.
pub fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::random;

    /// A workspace with `inside/` and a sibling `outside/` directory.
    struct Fixture {
        base: PathBuf,
        jail: Jail,
    }

    impl Fixture {
        fn new() -> Fixture {
            let base = std::env::temp_dir().join(format!("tendril-jail-{}", random::token_hex(4)));
            fs::create_dir_all(base.join("ws/src")).unwrap();
            fs::create_dir_all(base.join("outside")).unwrap();
            fs::write(base.join("ws/src/main.rs"), "fn main() {}").unwrap();
            fs::write(base.join("outside/secret.txt"), "secret").unwrap();
            let jail = Jail::new(&base.join("ws")).unwrap();
            Fixture { base, jail }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn resolves_ordinary_paths() {
        let f = Fixture::new();
        let main = f.jail.resolve("src/main.rs").unwrap();
        assert!(main.ends_with("main.rs"));
        assert_eq!(f.jail.relative(&main).as_deref(), Some("src/main.rs"));
        assert_eq!(f.jail.resolve("./src/./main.rs").unwrap(), main);
        assert_eq!(f.jail.resolve("src//main.rs").unwrap(), main);
        assert_eq!(f.jail.resolve("").unwrap(), f.jail.root());
        assert_eq!(f.jail.relative(f.jail.root()).as_deref(), Some(""));
    }

    #[test]
    fn refuses_dot_dot_everywhere() {
        let f = Fixture::new();
        for attempt in ["..", "../outside/secret.txt", "src/../../outside/secret.txt", "src/..", "a/b/../../.."] {
            assert!(matches!(f.jail.resolve(attempt), Err(FsError::Outside)), "{attempt}");
            assert!(matches!(f.jail.entry(attempt), Err(FsError::Outside)), "{attempt}");
            assert!(matches!(f.jail.target(attempt), Err(FsError::Outside)), "{attempt}");
        }
    }

    #[test]
    fn absolute_paths_stay_relative_to_the_workspace() {
        let f = Fixture::new();
        let outside = f.base.join("outside/secret.txt");
        // The absolute path is reinterpreted inside the workspace. On Unix its
        // components become a (non-existent) path under the root; on Windows the
        // drive-letter colon is refused outright. Either way it never escapes.
        let attempt = outside.to_string_lossy().into_owned();
        #[cfg(not(windows))]
        assert!(matches!(f.jail.resolve(&attempt), Err(FsError::NotFound)));
        #[cfg(windows)]
        assert!(matches!(f.jail.resolve(&attempt), Err(FsError::InvalidPath(_))));
        assert!(matches!(f.jail.resolve("/etc/passwd"), Err(FsError::NotFound)));
        assert!(f.jail.resolve("/src/main.rs").is_ok());
    }

    #[test]
    fn encoded_traversal_is_not_decoded_twice() {
        let f = Fixture::new();
        // The HTTP layer decodes once; what is left is a literal name.
        assert!(matches!(f.jail.resolve("%2e%2e/outside/secret.txt"), Err(FsError::NotFound)));
        assert!(matches!(f.jail.resolve("%252e%252e/outside"), Err(FsError::NotFound)));
        let target = f.jail.target("%2e%2e").unwrap();
        assert!(f.jail.contains(target.parent().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn backslashes_are_plain_characters_on_unix() {
        let f = Fixture::new();
        // On Linux `..\..\outside` is one (odd) file name, not a traversal.
        assert!(matches!(f.jail.resolve(r"..\..\outside\secret.txt"), Err(FsError::NotFound)));
        // New names may not contain backslashes, for portability.
        assert!(matches!(f.jail.target(r"src\evil"), Err(FsError::InvalidPath(_))));
    }

    #[cfg(windows)]
    #[test]
    fn backslashes_and_drive_letters_on_windows() {
        let f = Fixture::new();
        assert!(matches!(f.jail.resolve(r"..\outside\secret.txt"), Err(FsError::Outside)));
        assert!(f.jail.resolve(r"src\main.rs").is_ok());
        assert!(matches!(f.jail.resolve(r"C:\Windows\win.ini"), Err(FsError::InvalidPath(_))));
        assert!(matches!(f.jail.resolve("src/main.rs:stream"), Err(FsError::InvalidPath(_))));
        assert!(matches!(f.jail.resolve("NUL"), Err(FsError::InvalidPath(_))));
        assert!(matches!(f.jail.resolve("src/main.rs."), Err(FsError::InvalidPath(_))));
        assert!(f.jail.resolve("SRC/MAIN.RS").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_pointing_outside_are_refused() {
        let f = Fixture::new();
        std::os::unix::fs::symlink(f.base.join("outside"), f.base.join("ws/escape")).unwrap();
        std::os::unix::fs::symlink(f.base.join("outside/secret.txt"), f.base.join("ws/leak.txt")).unwrap();
        assert!(matches!(f.jail.resolve("escape/secret.txt"), Err(FsError::Outside)));
        assert!(matches!(f.jail.resolve("leak.txt"), Err(FsError::Outside)));
        assert!(matches!(f.jail.target("escape/new.txt"), Err(FsError::Outside)));
        // The link itself can still be addressed (to delete or rename it).
        let link = f.jail.entry("leak.txt").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert!(f.jail.contains(link.parent().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_inside_the_workspace_work() {
        let f = Fixture::new();
        std::os::unix::fs::symlink(f.base.join("ws/src"), f.base.join("ws/alias")).unwrap();
        let via_alias = f.jail.resolve("alias/main.rs").unwrap();
        assert_eq!(via_alias, f.jail.resolve("src/main.rs").unwrap());
    }

    #[test]
    fn new_names_are_validated() {
        let f = Fixture::new();
        assert!(f.jail.target("src/new.rs").is_ok());
        for bad in
            ["", "/", "src/a:b", "src/what?", "src/CON", "src/nul.txt", "src/COM1", "src/trailing.", "src/space "]
        {
            assert!(f.jail.target(bad).is_err(), "{bad:?} was accepted");
        }
        assert!(matches!(f.jail.target("missing/new.rs"), Err(FsError::NotFound)));
        assert!(matches!(f.jail.target("src/main.rs/x"), Err(FsError::NotADirectory)));
        assert!(validate_name("ok name.txt").is_ok());
        assert!(validate_name("console.log").is_ok());
        assert!(validate_name(&"x".repeat(256)).is_err());
        assert!(validate_name("a\0b").is_err());
    }

    #[test]
    fn nul_is_refused() {
        let f = Fixture::new();
        assert!(matches!(f.jail.resolve("src/main.rs\0.png"), Err(FsError::InvalidPath(_))));
    }

    #[test]
    fn the_root_is_detected() {
        assert!(Jail::is_root("").unwrap());
        assert!(Jail::is_root("/").unwrap());
        assert!(Jail::is_root("./.").unwrap());
        assert!(!Jail::is_root("a").unwrap());
    }

    #[test]
    fn display_strips_the_verbatim_prefix() {
        assert_eq!(display(Path::new(r"\\?\C:\Users\you")), r"C:\Users\you");
        assert_eq!(display(Path::new(r"\\?\UNC\server\share")), r"\\server\share");
        assert_eq!(display(Path::new("/home/you")), "/home/you");
    }
}
