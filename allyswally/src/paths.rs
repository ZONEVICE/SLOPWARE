//! The on-disk layout under `%USERPROFILE%\.allyswally`.
//!
//! One place that knows where everything lives and makes sure the directories
//! exist. Everything the app persists is rooted here:
//!
//! ```text
//! %USERPROFILE%\.allyswally\
//!   user-data\   config.json, shortcuts.json, launchers.json, clipboard.json, scripts.json
//!   logs\        <date>.jsonl
//!   backups\     <date-time> snapshots taken before a reset or import
//! ```

use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Paths {
    pub root: PathBuf,
    pub user_data: PathBuf,
    pub logs: PathBuf,
    pub backups: PathBuf,
}

impl Paths {
    /// Resolve the layout from `%USERPROFILE%` (falling back to the current
    /// directory if the variable is somehow unset) and create every directory.
    pub fn resolve() -> io::Result<Paths> {
        let home = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let root = home.join(".allyswally");
        let paths = Paths {
            user_data: root.join("user-data"),
            logs: root.join("logs"),
            backups: root.join("backups"),
            root,
        };
        for dir in [&paths.root, &paths.user_data, &paths.logs, &paths.backups] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(paths)
    }

    pub fn config_file(&self) -> PathBuf {
        self.user_data.join("config.json")
    }

    pub fn user_data_file(&self, name: &str) -> PathBuf {
        self.user_data.join(name)
    }
}

/// Write `contents` to `path` atomically: write a sibling temp file, flush it,
/// then rename over the target. A reader (or a person editing by hand) never
/// sees a half-written file, and a crash mid-write leaves the old file intact.
pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents)?;
        f.flush()?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}
