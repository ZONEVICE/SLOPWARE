//! The workspace file system: confinement, operations, text handling, search
//! and the folder picker.
//!
//! Every path that arrives from the browser is **workspace-relative** and goes
//! through [`jail::Jail`] before it touches the disk. Nothing here knows about
//! HTTP: functions take a `Jail` and plain values, and return [`FsError`],
//! which the HTTP layer maps to a status code and a JSON body.
//!
//! - [`jail`]: path validation and confinement (traversal, symlinks, Windows rules).
//! - [`text`]: UTF-8/BOM/line-ending decoding and encoding, binary detection.
//! - [`ops`]: list, stat, read, write (atomic, conflict-checked), create,
//!   rename/move, copy, duplicate, delete.
//! - [`search`]: the file list for "Go to File" and "Find in Files".
//! - [`picker`]: the folder picker that browses the host from its root.
//! - [`mime`]: which files open in a viewer, and their content types.

pub mod jail;
pub mod mime;
pub mod ops;
pub mod picker;
pub mod search;
pub mod text;

use std::fmt;
use std::io;

/// Everything that can go wrong in a file operation.
#[derive(Debug)]
pub enum FsError {
    /// The path does not exist.
    NotFound,
    /// The target of a create/rename/copy already exists.
    AlreadyExists,
    /// A directory was expected.
    NotADirectory,
    /// A file was expected.
    IsADirectory,
    /// The path or name is malformed (with the reason).
    InvalidPath(String),
    /// The path resolves outside the workspace.
    Outside,
    /// The OS refused access.
    PermissionDenied,
    /// The file is marked read-only; Tendril does not override that.
    ReadOnly,
    /// The file is larger than the editor limit.
    TooLarge { size: u64, limit: u64 },
    /// The file is not UTF-8 text.
    Binary,
    /// The file changed on disk since the browser loaded it.
    Conflict { mtime: u64, size: u64, exists: bool },
    /// Any other I/O error (message only; never file contents).
    Io(String),
}

impl FsError {
    /// Stable machine-readable code for the browser.
    pub fn code(&self) -> &'static str {
        match self {
            FsError::NotFound => "not_found",
            FsError::AlreadyExists => "exists",
            FsError::NotADirectory => "not_a_directory",
            FsError::IsADirectory => "is_a_directory",
            FsError::InvalidPath(_) => "invalid_path",
            FsError::Outside => "outside_workspace",
            FsError::PermissionDenied => "permission_denied",
            FsError::ReadOnly => "read_only",
            FsError::TooLarge { .. } => "too_large",
            FsError::Binary => "binary",
            FsError::Conflict { .. } => "conflict",
            FsError::Io(_) => "io_error",
        }
    }

    /// HTTP status for the error.
    pub fn status(&self) -> u16 {
        match self {
            FsError::NotFound => 404,
            FsError::AlreadyExists | FsError::Conflict { .. } => 409,
            FsError::NotADirectory | FsError::IsADirectory | FsError::InvalidPath(_) => 400,
            FsError::Outside | FsError::PermissionDenied | FsError::ReadOnly => 403,
            FsError::TooLarge { .. } => 413,
            FsError::Binary => 415,
            FsError::Io(_) => 500,
        }
    }
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FsError::NotFound => write!(f, "No such file or directory"),
            FsError::AlreadyExists => write!(f, "A file or folder with that name already exists"),
            FsError::NotADirectory => write!(f, "Not a folder"),
            FsError::IsADirectory => write!(f, "Is a folder"),
            FsError::InvalidPath(why) => write!(f, "Invalid path: {why}"),
            FsError::Outside => write!(f, "The path is outside the workspace"),
            FsError::PermissionDenied => write!(f, "Permission denied"),
            FsError::ReadOnly => write!(f, "The file is read-only"),
            FsError::TooLarge { size, limit } => {
                write!(f, "The file is too large to edit ({size} bytes; the limit is {limit} bytes)")
            }
            FsError::Binary => write!(f, "The file is binary or not UTF-8 text"),
            FsError::Conflict { .. } => write!(f, "The file changed on disk since it was opened"),
            FsError::Io(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for FsError {}

impl From<io::Error> for FsError {
    fn from(err: io::Error) -> Self {
        match err.kind() {
            io::ErrorKind::NotFound => FsError::NotFound,
            io::ErrorKind::AlreadyExists => FsError::AlreadyExists,
            io::ErrorKind::PermissionDenied => FsError::PermissionDenied,
            io::ErrorKind::NotADirectory => FsError::NotADirectory,
            io::ErrorKind::IsADirectory => FsError::IsADirectory,
            io::ErrorKind::ReadOnlyFilesystem => FsError::ReadOnly,
            io::ErrorKind::InvalidFilename => FsError::InvalidPath("the name is not allowed here".into()),
            _ => FsError::Io(err.to_string()),
        }
    }
}

/// Result alias for this module.
pub type FsResult<T> = Result<T, FsError>;
