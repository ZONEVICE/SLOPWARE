//! File operations inside the current workspace. Every path is
//! workspace-relative and goes through the workspace's `Jail`.
//!
//! | Method & path | Body / query | Answer |
//! | --- | --- | --- |
//! | `GET /api/fs/list?path=` | | `{entries, truncated}` |
//! | `GET /api/fs/stat?path=` | | one entry |
//! | `POST /api/fs/stats` | `{paths}` | `{stats: {path: {mtime,size} or null}}` |
//! | `GET /api/fs/read?path=` | | the text, metadata in `X-Tendril-*` headers |
//! | `PUT /api/fs/write?path=` | the text; `X-Tendril-Eol`, `-Bom`, `-Expect-Mtime`, `-Expect-Size` | `{mtime, size, created}` or 409 |
//! | `POST /api/fs/create` | `{path, dir}` | `{path}` |
//! | `POST /api/fs/rename` | `{from, to, overwrite}` | `{path}` |
//! | `POST /api/fs/copy` | `{from, to}` | `{path}` |
//! | `POST /api/fs/duplicate` | `{path}` | `{path}` |
//! | `POST /api/fs/delete` | `{paths}` | `{deleted, errors}` |
//! | `PUT /api/fs/upload?path=&overwrite=` | raw bytes | `{path, size}` |
//!
//! Text travels LF-only and without BOM; the headers say how to write it
//! back (see `services::files::text`).

use std::path::PathBuf;
use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use http_body::Body as _;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::io::AsyncWriteExt;

use super::super::error::{ApiError, ApiResult};
use super::super::guard::Ws;
use super::super::state::AppState;
use super::Routes;
use crate::core::atomic;
use crate::services::events::Event;
use crate::services::files::jail::{self, Jail};
use crate::services::files::ops::{self, Expected};
use crate::services::files::text::Eol;
use crate::services::files::{FsError, FsResult};

/// Registers the routes.
pub fn register(mut routes: Routes) -> Routes {
    routes.private = routes
        .private
        .route("/api/fs/list", get(list))
        .route("/api/fs/stat", get(stat))
        .route("/api/fs/stats", post(stats))
        .route("/api/fs/read", get(read))
        .route("/api/fs/write", put(write).layer(DefaultBodyLimit::disable()))
        .route("/api/fs/create", post(create))
        .route("/api/fs/rename", post(rename))
        .route("/api/fs/copy", post(copy))
        .route("/api/fs/duplicate", post(duplicate))
        .route("/api/fs/delete", post(delete))
        .route("/api/fs/upload", put(upload).layer(DefaultBodyLimit::disable()));
    routes
}

#[derive(Deserialize)]
struct PathQuery {
    #[serde(default)]
    path: String,
}

/// Runs a blocking file operation on the blocking pool.
async fn blocking<T: Send + 'static>(job: impl FnOnce() -> FsResult<T> + Send + 'static) -> ApiResult<T> {
    Ok(tokio::task::spawn_blocking(job).await??)
}

fn log_op(state: &AppState, ws: &Ws, op: &str, path: &std::path::Path, to: Option<&std::path::Path>) {
    state.publish(Event::FileOp {
        ip: ws.ip.to_string(),
        op: op.into(),
        path: jail::display(path),
        to: to.map(jail::display),
    });
}

async fn list(ws: Ws, Query(q): Query<PathQuery>) -> ApiResult<Json<Value>> {
    let jail = ws.jail.clone();
    let (entries, truncated) = blocking(move || ops::list(&jail, &q.path)).await?;
    Ok(Json(json!({ "entries": entries, "truncated": truncated })))
}

async fn stat(ws: Ws, Query(q): Query<PathQuery>) -> ApiResult<Json<ops::EntryInfo>> {
    let jail = ws.jail.clone();
    Ok(Json(blocking(move || ops::stat(&jail, &q.path)).await?))
}

#[derive(Deserialize)]
struct StatsBody {
    paths: Vec<String>,
}

/// Modification times of open files, so the browser notices external edits.
async fn stats(ws: Ws, Json(body): Json<StatsBody>) -> ApiResult<Json<Value>> {
    let jail = ws.jail.clone();
    let result = blocking(move || {
        let mut out = Map::new();
        for path in body.paths.into_iter().take(500) {
            let value = match jail.resolve(&path).and_then(|p| std::fs::metadata(p).map_err(FsError::from)) {
                Ok(meta) if meta.is_file() => json!({ "mtime": ops::mtime_ms(&meta), "size": meta.len() }),
                _ => Value::Null,
            };
            out.insert(path, value);
        }
        Ok(out)
    })
    .await?;
    Ok(Json(json!({ "stats": result })))
}

async fn read(State(state): State<AppState>, ws: Ws, Query(q): Query<PathQuery>) -> ApiResult<Response> {
    let limit = state.settings.get().max_editor_file_mb * 1024 * 1024;
    let jail = ws.jail.clone();
    let (doc, meta) = blocking(move || ops::read_text(&jail, &q.path, limit)).await?;
    let mut response = doc.text.into_response();
    let h = response.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    h.insert("x-tendril-mtime", HeaderValue::from(meta.mtime));
    h.insert("x-tendril-size", HeaderValue::from(meta.size));
    h.insert("x-tendril-eol", HeaderValue::from_static(doc.eol.as_str()));
    h.insert("x-tendril-bom", HeaderValue::from_static(if doc.bom { "1" } else { "0" }));
    h.insert("x-tendril-readonly", HeaderValue::from_static(if meta.readonly { "1" } else { "0" }));
    Ok(response)
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

async fn write(
    State(state): State<AppState>,
    ws: Ws,
    Query(q): Query<PathQuery>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Json<Value>> {
    // The editor limit plus room for line ending growth.
    let limit = (state.settings.get().max_editor_file_mb * 1024 * 1024) as usize * 2 + 1024;
    let bytes = axum::body::to_bytes(body, limit)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "The text is too large to save"))?;
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| ApiError::bad_request("the text is not UTF-8"))?;
    let eol = header(&headers, "x-tendril-eol").and_then(Eol::parse).unwrap_or(Eol::Lf);
    let bom = header(&headers, "x-tendril-bom") == Some("1");
    let expected = match (header(&headers, "x-tendril-expect-mtime"), header(&headers, "x-tendril-expect-size")) {
        (Some(m), Some(s)) => Some(Expected {
            mtime: m.parse().map_err(|_| ApiError::bad_request("bad X-Tendril-Expect-Mtime"))?,
            size: s.parse().map_err(|_| ApiError::bad_request("bad X-Tendril-Expect-Size"))?,
        }),
        _ => None,
    };
    let jail = ws.jail.clone();
    let rel = q.path.clone();
    let (meta, created) = blocking(move || ops::write_text(&jail, &rel, &text, eol, bom, expected)).await?;
    log_op(&state, &ws, if created { "create" } else { "write" }, &ws.jail.root().join(&q.path), None);
    Ok(Json(json!({ "mtime": meta.mtime, "size": meta.size, "created": created })))
}

#[derive(Deserialize)]
struct CreateBody {
    path: String,
    #[serde(default)]
    dir: bool,
}

async fn create(State(state): State<AppState>, ws: Ws, Json(body): Json<CreateBody>) -> ApiResult<Json<Value>> {
    let jail = ws.jail.clone();
    let rel = body.path.clone();
    let path = blocking(move || ops::create(&jail, &rel, body.dir)).await?;
    log_op(&state, &ws, if body.dir { "mkdir" } else { "create" }, &path, None);
    Ok(Json(json!({ "path": relative(&ws.jail, &path) })))
}

#[derive(Deserialize)]
struct MoveBody {
    from: String,
    to: String,
    #[serde(default)]
    overwrite: bool,
}

async fn rename(State(state): State<AppState>, ws: Ws, Json(body): Json<MoveBody>) -> ApiResult<Json<Value>> {
    let jail = ws.jail.clone();
    let (src, dst) = blocking(move || ops::rename(&jail, &body.from, &body.to, body.overwrite)).await?;
    log_op(&state, &ws, "move", &src, Some(&dst));
    Ok(Json(json!({ "path": relative(&ws.jail, &dst) })))
}

async fn copy(State(state): State<AppState>, ws: Ws, Json(body): Json<MoveBody>) -> ApiResult<Json<Value>> {
    let jail = ws.jail.clone();
    let (src, dst) = blocking(move || ops::copy(&jail, &body.from, &body.to)).await?;
    log_op(&state, &ws, "copy", &src, Some(&dst));
    Ok(Json(json!({ "path": relative(&ws.jail, &dst) })))
}

async fn duplicate(State(state): State<AppState>, ws: Ws, Json(body): Json<PathQuery>) -> ApiResult<Json<Value>> {
    let jail = ws.jail.clone();
    let rel = body.path.clone();
    let to = blocking(move || ops::duplicate(&jail, &rel)).await?;
    let src = ws.jail.root().join(&body.path);
    let dst = ws.jail.root().join(&to);
    log_op(&state, &ws, "copy", &src, Some(&dst));
    Ok(Json(json!({ "path": to })))
}

#[derive(Deserialize)]
struct DeleteBody {
    paths: Vec<String>,
}

async fn delete(State(state): State<AppState>, ws: Ws, Json(body): Json<DeleteBody>) -> ApiResult<Json<Value>> {
    let jail = ws.jail.clone();
    let results = blocking(move || {
        Ok(body.paths.into_iter().take(10_000).map(|p| (p.clone(), ops::delete(&jail, &p))).collect::<Vec<_>>())
    })
    .await?;
    let mut deleted = 0;
    let mut errors = Vec::new();
    for (rel, result) in results {
        match result {
            Ok(path) => {
                deleted += 1;
                log_op(&state, &ws, "delete", &path, None);
            }
            Err(err) => errors.push(json!({ "path": rel, "error": err.code(), "message": err.to_string() })),
        }
    }
    Ok(Json(json!({ "deleted": deleted, "errors": errors })))
}

#[derive(Deserialize)]
struct UploadQuery {
    path: String,
    #[serde(default)]
    overwrite: Option<String>,
}

/// Deletes the temporary upload file unless the upload completed.
struct TempGuard(Option<PathBuf>);

impl Drop for TempGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Streams the request body to a temporary file next to the target, then
/// renames it into place. Never holds the whole file in memory.
async fn upload(
    State(state): State<AppState>,
    ws: Ws,
    Query(q): Query<UploadQuery>,
    headers: HeaderMap,
    mut body: Body,
) -> ApiResult<Json<Value>> {
    let limit = state.settings.get().max_upload_mb * 1024 * 1024;
    let too_large = || {
        ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", format!("Uploads are limited to {} MiB", limit >> 20))
    };
    if header(&headers, "content-length").and_then(|v| v.parse::<u64>().ok()).is_some_and(|n| n > limit) {
        return Err(too_large());
    }
    let overwrite = matches!(q.overwrite.as_deref(), Some("1" | "true"));
    let jail: Arc<Jail> = ws.jail.clone();
    let rel = q.path.clone();
    let (target, previous) = blocking(move || {
        let target = jail.target(&rel)?;
        let previous = match std::fs::metadata(&target) {
            Ok(meta) if meta.is_dir() => return Err(FsError::IsADirectory),
            Ok(_) if !overwrite => return Err(FsError::AlreadyExists),
            Ok(meta) if meta.permissions().readonly() => return Err(FsError::ReadOnly),
            Ok(meta) => Some(meta),
            Err(_) => None,
        };
        Ok((target, previous))
    })
    .await?;

    let temp = atomic::temp_path_for(&target);
    let mut guard = TempGuard(Some(temp.clone()));
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .await
        .map_err(|e| ApiError::from(FsError::from(e)))?;
    let mut written: u64 = 0;
    while let Some(frame) = std::future::poll_fn(|cx| std::pin::Pin::new(&mut body).poll_frame(cx)).await {
        let frame = frame.map_err(|e| ApiError::bad_request(format!("upload interrupted: {e}")))?;
        if let Ok(data) = frame.into_data() {
            written += data.len() as u64;
            if written > limit {
                return Err(too_large());
            }
            file.write_all(&data).await.map_err(|e| ApiError::from(FsError::from(e)))?;
        }
    }
    file.sync_all().await.map_err(|e| ApiError::from(FsError::from(e)))?;
    drop(file);
    let (from, to) = (temp.clone(), target.clone());
    blocking(move || {
        if let Some(meta) = &previous {
            ops::keep_attributes(&from, meta);
        }
        atomic::rename_replacing(&from, &to).map_err(FsError::from)
    })
    .await?;
    guard.0 = None;
    log_op(&state, &ws, "upload", &target, None);
    Ok(Json(json!({ "path": relative(&ws.jail, &target), "size": written })))
}

fn relative(jail: &Jail, path: &std::path::Path) -> String {
    // `path` is canonical-parent + name, so it is inside the workspace.
    jail.relative(path).unwrap_or_default()
}
