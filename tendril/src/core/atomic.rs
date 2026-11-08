//! Atomic file replacement: write a temporary file next to the target, then
//! rename it over the target.
//!
//! Readers never observe a half-written file, and a failure at any point
//! leaves the original untouched. The temporary file lives in the target's own
//! directory (a rename across file systems is not atomic) and is removed by
//! `Drop` unless [`AtomicFile::commit`] succeeded, so an error never leaves a
//! residual file behind - the prompt forbids residue inside the workspace.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use super::random;

/// A file being written that replaces `target` on [`commit`](Self::commit).
pub struct AtomicFile {
    target: PathBuf,
    temp: PathBuf,
    file: Option<File>,
}

impl AtomicFile {
    /// Creates the temporary file. With `private`, it is readable by the owner
    /// only (mode 600 on Unix; Windows profiles are already per-user).
    pub fn create(target: &Path, private: bool) -> io::Result<AtomicFile> {
        let temp = temp_path_for(target);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        #[cfg(not(unix))]
        let _ = private;
        let file = options.open(&temp)?;
        Ok(AtomicFile { target: target.to_path_buf(), temp, file: Some(file) })
    }

    /// The temporary path (to copy permissions onto it before committing).
    pub fn temp_path(&self) -> &Path {
        &self.temp
    }

    /// The open temporary file.
    pub fn file(&mut self) -> &mut File {
        self.file.as_mut().expect("AtomicFile used after commit")
    }

    /// Flushes to disk and renames over the target.
    pub fn commit(mut self) -> io::Result<()> {
        if let Some(mut file) = self.file.take() {
            file.flush()?;
            file.sync_all()?;
        }
        rename_replacing(&self.temp, &self.target)?;
        // Mark as committed: Drop must not delete the (now renamed) file.
        self.temp = PathBuf::new();
        Ok(())
    }
}

impl Drop for AtomicFile {
    fn drop(&mut self) {
        self.file.take();
        if !self.temp.as_os_str().is_empty() {
            let _ = fs::remove_file(&self.temp);
        }
    }
}

/// Writes `bytes` to `target` atomically.
pub fn write(target: &Path, bytes: &[u8], private: bool) -> io::Result<()> {
    let mut file = AtomicFile::create(target, private)?;
    file.file().write_all(bytes)?;
    file.commit()
}

/// `.<name>.<random>.tendril-tmp` in the same directory as `target`.
pub fn temp_path_for(target: &Path) -> PathBuf {
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let temp_name = format!(".{name}.{}.tendril-tmp", random::token_hex(4));
    match target.parent() {
        Some(parent) => parent.join(temp_name),
        None => PathBuf::from(temp_name),
    }
}

/// `fs::rename` that also replaces an existing target on Windows, retrying
/// briefly when another process (an antivirus scanner, an indexer) holds the
/// target open for a moment.
pub fn rename_replacing(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(err) if cfg!(windows) && err.kind() == io::ErrorKind::PermissionDenied && attempt < 5 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(40 * attempt));
            }
            Err(err) => return Err(err),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tendril-atomic-{name}-{}", random::token_hex(4)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn replaces_the_target_and_leaves_nothing_else() {
        let dir = scratch("replace");
        let target = dir.join("a.txt");
        fs::write(&target, b"old").unwrap();
        write(&target, b"new", false).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_abandoned_write_leaves_no_residue() {
        let dir = scratch("abandon");
        let target = dir.join("b.txt");
        {
            let mut file = AtomicFile::create(&target, true).unwrap();
            file.file().write_all(b"partial").unwrap();
            // Dropped without commit.
        }
        assert!(!target.exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn private_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("private");
        let target = dir.join("secret.json");
        write(&target, b"{}", true).unwrap();
        let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        fs::remove_dir_all(dir).unwrap();
    }
}
