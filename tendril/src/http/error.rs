//! The JSON error body every API route returns on failure:
//!
//! ```json
//! {"error": "not_found", "message": "No such file or directory"}
//! ```
//!
//! `error` is a stable machine-readable code the browser switches on;
//! `message` is for people. Some errors add fields (`remaining` for a wrong
//! password, `mtime`/`size`/`exists` for a save conflict).

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};

use crate::services::files::FsError;

/// An API error.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub extra: Map<String, Value>,
}

impl ApiError {
    /// An error with a status, a code and a message.
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> ApiError {
        ApiError { status, code, message: message.into(), extra: Map::new() }
    }

    /// Adds a field to the body.
    pub fn with(mut self, key: &str, value: impl Into<Value>) -> ApiError {
        self.extra.insert(key.into(), value.into());
        self
    }

    /// 400.
    pub fn bad_request(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    /// 401: no valid session.
    pub fn unauthorized() -> ApiError {
        ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized", "Log in first")
    }

    /// 404 for an unknown or foreign workspace id.
    pub fn no_workspace() -> ApiError {
        ApiError::new(StatusCode::NOT_FOUND, "no_workspace", "Open a folder first")
    }

    /// 500 with a message.
    pub fn internal(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }
}

impl From<FsError> for ApiError {
    fn from(err: FsError) -> ApiError {
        let status = StatusCode::from_u16(err.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut api = ApiError::new(status, err.code(), err.to_string());
        match err {
            FsError::Conflict { mtime, size, exists } => {
                api = api.with("mtime", mtime).with("size", size).with("exists", exists);
            }
            FsError::TooLarge { size, limit } => {
                api = api.with("size", size).with("limit", limit);
            }
            _ => {}
        }
        api
    }
}

impl From<tokio::task::JoinError> for ApiError {
    fn from(err: tokio::task::JoinError) -> ApiError {
        ApiError::internal(format!("background task failed: {err}"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = Map::new();
        body.insert("error".into(), json!(self.code));
        body.insert("message".into(), json!(self.message));
        body.extend(self.extra);
        (self.status, Json(Value::Object(body))).into_response()
    }
}

/// Result alias for handlers.
pub type ApiResult<T> = Result<T, ApiError>;
