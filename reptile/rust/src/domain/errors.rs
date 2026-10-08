//! Domain errors.
//!
//! Every rule violation is an `AppError` with a machine `code` and an HTTP
//! `status`. The HTTP layer translates it into `{ error: { code, message } }`,
//! and the peer client turns that back into an error with the same code, so a
//! rule written once reads the same on both machines, whichever
//! implementation each one runs.

use crate::fs::mutate::FsError;
use serde_json::{json, Map, Value};
use std::fmt;
use std::io;

#[derive(Debug, Clone)]
pub struct AppError {
    pub code: String,
    /// Human-readable, shown in the interface as is.
    pub message: String,
    pub status: u16,
    pub details: Option<Value>,
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: &str, message: impl Into<String>, status: u16) -> AppError {
        AppError { code: code.to_string(), message: message.into(), status, details: None }
    }

    pub fn with_details(mut self, details: Value) -> AppError {
        self.details = Some(details);
        self
    }

    pub fn bad_request(message: impl Into<String>, code: &str) -> AppError {
        AppError::new(code, message, 400)
    }

    pub fn unauthorized() -> AppError {
        AppError::new("unauthorized", "This session is not valid any more. Connect again with the PIN.", 401)
    }

    pub fn forbidden(message: impl Into<String>, code: &str) -> AppError {
        AppError::new(code, message, 403)
    }

    pub fn not_found(message: impl Into<String>) -> AppError {
        AppError::new("not_found", message, 404)
    }

    pub fn conflict(message: impl Into<String>, code: &str) -> AppError {
        AppError::new(code, message, 409)
    }

    pub fn payload_too_large(message: impl Into<String>) -> AppError {
        AppError::new("payload_too_large", message, 413)
    }

    pub fn unsupported_media(message: impl Into<String>) -> AppError {
        AppError::new("unsupported_media_type", message, 415)
    }

    pub fn unavailable(message: impl Into<String>, code: &str) -> AppError {
        AppError::new(code, message, 503)
    }

    /// A 500 whose message does not leak internals.
    pub fn internal() -> AppError {
        AppError::new("internal", "Something went wrong.", 500)
    }

    /// `{ code, message, details? }`.
    pub fn to_json(&self) -> Value {
        let mut body = Map::new();
        body.insert("code".into(), json!(self.code));
        body.insert("message".into(), json!(self.message));
        if let Some(details) = &self.details {
            body.insert("details".into(), details.clone());
        }
        Value::Object(body)
    }
}

/// Translate a filesystem error into what the peer is told.
pub fn from_fs(error: FsError) -> AppError {
    match error {
        FsError::Code(code, message) => match code {
            "conflict" | "not_found" => AppError::conflict(message, "conflict"),
            "unsafe_path" => AppError::forbidden(message, "unsafe_path"),
            "size_mismatch" => AppError::bad_request(message, "size_mismatch"),
            _ => AppError::new("internal", message, 500),
        },
        FsError::Io(error) => from_io(&error),
    }
}

pub fn from_io(error: &io::Error) -> AppError {
    use io::ErrorKind::*;
    match error.kind() {
        AlreadyExists | DirectoryNotEmpty | IsADirectory | NotADirectory | NotFound => {
            AppError::conflict(error.to_string(), "conflict")
        }
        PermissionDenied => AppError::forbidden("The host does not have permission to change this path.", "permission"),
        StorageFull => AppError::unavailable("The host has no space left on its disk.", "no_space"),
        _ => AppError::new("internal", error.to_string(), 500),
    }
}
