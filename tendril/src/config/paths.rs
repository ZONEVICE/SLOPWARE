//! The persistence directory, `~/.tendril`.
//!
//! Everything Tendril persists lives here and nowhere else: never inside a
//! workspace. The home directory comes from `HOME` (Unix) or `USERPROFILE`
//! (Windows) without extra crates.
//!
//! ```text
//! ~/.tendril/
//!   settings.json      user settings (see config::settings)
//!   recent.json        recently opened workspaces
//!   cert/cert.pem      self-signed certificate, regenerated on every start
//!   cert/key.pem       its private key (mode 600 on Unix)
//!   logs/YYYY-MM-DD.jsonl   JSON Lines logs, one file per UTC day
//! ```

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Name of the persistence directory inside the user's home.
pub const DIR_NAME: &str = ".tendril";

/// The persistence directory and the well-known paths inside it.
#[derive(Debug, Clone)]
pub struct DataDir {
    root: PathBuf,
}

impl DataDir {
    /// `~/.tendril` for the user running the process. Falls back to the
    /// current directory when no home directory is known.
    pub fn for_current_user() -> DataDir {
        DataDir { root: home_dir().unwrap_or_else(|| PathBuf::from(".")).join(DIR_NAME) }
    }

    /// A data directory at an explicit location (tests use a temp dir).
    pub fn at(root: impl Into<PathBuf>) -> DataDir {
        DataDir { root: root.into() }
    }

    /// The directory itself.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `settings.json`.
    pub fn settings_file(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    /// `recent.json`.
    pub fn recent_file(&self) -> PathBuf {
        self.root.join("recent.json")
    }

    /// `cert/`.
    pub fn cert_dir(&self) -> PathBuf {
        self.root.join("cert")
    }

    /// `logs/`.
    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    /// Creates the directory tree (owner-only on Unix).
    pub fn ensure(&self) -> io::Result<()> {
        for dir in [self.root.clone(), self.cert_dir(), self.logs_dir()] {
            fs::create_dir_all(&dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
            }
        }
        Ok(())
    }
}

/// The current user's home directory from the environment.
pub fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}
