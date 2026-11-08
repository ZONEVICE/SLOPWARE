//! Raw file contents for the viewers and for downloads.
//!
//! `GET /api/fs/raw?ws=<id>&path=<rel>[&download=1]` streams the file with
//! `Range` support (206), so a video can be seeked without loading it. The
//! workspace id travels in the query because `<img>`, `<video>` and `<iframe>`
//! cannot send custom headers; the session cookie still authenticates.
//!
//! Workspace files must never run as active content under Tendril's origin
//! (an HTML file could steal the session and drive the terminal):
//!
//! - images, audio, video and PDF are served inline with their real type;
//! - SVG is served as `image/svg+xml` with a sandboxing CSP: the viewer shows
//!   it in an `<img>`, where scripts never run, and opening the URL directly
//!   runs nothing either;
//! - everything else is `application/octet-stream` as an attachment.

use std::io::SeekFrom;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, LAST_MODIFIED,
    RANGE,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;
use tokio::io::AsyncSeekExt;

use super::super::body::{FileBody, Range, parse_range};
use super::super::error::{ApiError, ApiResult};
use super::super::guard::Ws;
use super::super::state::AppState;
use super::Routes;
use crate::core::clock;
use crate::services::events::Event;
use crate::services::files::{FsError, jail, mime, ops};

/// Registers the route.
pub fn register(mut routes: Routes) -> Routes {
    routes.private = routes.private.route("/api/fs/raw", get(raw));
    routes
}

#[derive(Deserialize)]
struct RawQuery {
    path: String,
    #[serde(default)]
    download: Option<String>,
}

/// `attachment; filename="..."; filename*=UTF-8''...` (RFC 6266).
pub fn disposition(kind: &str, name: &str) -> String {
    let ascii: String =
        name.chars().map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' { c } else { '_' }).collect();
    let mut encoded = String::new();
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("{kind}; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

async fn raw(
    State(state): State<AppState>,
    ws: Ws,
    Query(q): Query<RawQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let jail = ws.jail.clone();
    let rel = q.path.clone();
    let (path, meta) = tokio::task::spawn_blocking(move || -> Result<_, FsError> {
        let path = jail.resolve(&rel)?;
        let meta = std::fs::metadata(&path)?;
        if meta.is_dir() {
            return Err(FsError::IsADirectory);
        }
        Ok((path, meta))
    })
    .await??;

    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let content_type = mime::content_type(&name);
    let download = matches!(q.download.as_deref(), Some("1" | "true")) || content_type == "application/octet-stream";
    if download {
        state.publish(Event::FileOp {
            ip: ws.ip.to_string(),
            op: "download".into(),
            path: jail::display(&path),
            to: None,
        });
    }

    let size = meta.len();
    let range = parse_range(headers.get(RANGE).and_then(|v| v.to_str().ok()), size);
    if range == Range::Unsatisfiable {
        let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
        response.headers_mut().insert(CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{size}")).unwrap());
        return Ok(response);
    }
    let (status, start, length) = match range {
        Range::Part { start, end } => (StatusCode::PARTIAL_CONTENT, start, end - start + 1),
        _ => (StatusCode::OK, 0, size),
    };
    let mut file = tokio::fs::File::open(&path).await.map_err(|e| ApiError::from(FsError::from(e)))?;
    if start > 0 {
        file.seek(SeekFrom::Start(start)).await.map_err(|e| ApiError::from(FsError::from(e)))?;
    }

    let mut response = Response::new(Body::new(FileBody::new(file, length)));
    *response.status_mut() = status;
    let h = response.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static(if download { "application/octet-stream" } else { content_type }));
    h.insert(CONTENT_LENGTH, HeaderValue::from(length));
    h.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-cache"));
    h.insert(LAST_MODIFIED, HeaderValue::from_str(&clock::http_date(ops::mtime_ms(&meta))).unwrap());
    if status == StatusCode::PARTIAL_CONTENT {
        let value = format!("bytes {start}-{}/{size}", start + length - 1);
        h.insert(CONTENT_RANGE, HeaderValue::from_str(&value).unwrap());
    }
    let kind = if download { "attachment" } else { "inline" };
    if let Ok(value) = HeaderValue::from_str(&disposition(kind, &name)) {
        h.insert(CONTENT_DISPOSITION, value);
    }
    if download || mime::is_active(content_type) {
        h.insert(
            "content-security-policy",
            HeaderValue::from_static("sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"),
        );
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_disposition_encodes_names() {
        assert_eq!(disposition("attachment", "a.txt"), "attachment; filename=\"a.txt\"; filename*=UTF-8''a.txt");
        let odd = disposition("inline", "ñ \"x\".png");
        assert!(odd.contains("filename=\"_ _x_.png\""), "{odd}");
        assert!(odd.contains("filename*=UTF-8''%C3%B1%20%22x%22.png"), "{odd}");
    }
}
