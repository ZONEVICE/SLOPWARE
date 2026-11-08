//! Git for the workspace (services/git.rs), with the host's `git` program.
//!
//! - `GET /api/git/status` -> `{available, repo, version?, branch, commit,
//!   upstream, ahead, behind, files, truncated}`. `available: false` when the
//!   host has no git; `repo: false` outside a repository. The browser polls
//!   it quietly (`X-Tendril-Quiet`), so polling is not activity.
//! - `GET /api/git/show?path=&ref=HEAD|INDEX` -> the file's text there (LF),
//!   with `X-Tendril-Exists: 0` and an empty body when it is not there.
//! - `POST /api/git/stage|unstage|discard {paths}`.
//! - `POST /api/git/commit {message, all}` -> `{summary}`.
//! - `GET /api/git/branches` -> `{current, local, remote}`.
//! - `POST /api/git/checkout {branch, remote}`, `POST /api/git/branch {name}`.
//! - `POST /api/git/fetch|pull|push`.
//!
//! Errors carry git's own message: 409 `git_failed` (refused by git, e.g. a
//! merge needed), 400 `git_invalid`, 404 `not_a_repository`, 501
//! `git_unavailable`, 504 `git_timeout`. Each operation is logged (`git`
//! event: its name and how many paths), never messages or file contents.

use std::path::PathBuf;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::{Value, json};

use super::super::error::{ApiError, ApiResult};
use super::super::guard::Ws;
use super::super::state::AppState;
use super::Routes;
use crate::services::events::Event;
use crate::services::git::{self, GitError};

/// Registers the routes.
pub fn register(mut routes: Routes) -> Routes {
    routes.private = routes
        .private
        .route("/api/git/status", get(status))
        .route("/api/git/show", get(show))
        .route("/api/git/stage", post(stage))
        .route("/api/git/unstage", post(unstage))
        .route("/api/git/discard", post(discard))
        .route("/api/git/commit", post(commit))
        .route("/api/git/branches", get(branches))
        .route("/api/git/checkout", post(checkout))
        .route("/api/git/branch", post(branch))
        .route("/api/git/fetch", post(fetch))
        .route("/api/git/pull", post(pull))
        .route("/api/git/push", post(push));
    routes
}

impl From<GitError> for ApiError {
    fn from(err: GitError) -> Self {
        let message = err.to_string();
        match err {
            GitError::Unavailable => ApiError::new(StatusCode::NOT_IMPLEMENTED, "git_unavailable", message),
            GitError::NotARepository => ApiError::new(StatusCode::NOT_FOUND, "not_a_repository", message),
            GitError::Invalid(_) => ApiError::new(StatusCode::BAD_REQUEST, "git_invalid", message),
            GitError::Failed(_) => ApiError::new(StatusCode::CONFLICT, "git_failed", message),
            GitError::TimedOut => ApiError::new(StatusCode::GATEWAY_TIMEOUT, "git_timeout", message),
            GitError::File(fs) => ApiError::from(fs),
            GitError::Io(_) => ApiError::internal(message),
        }
    }
}

/// Runs a git operation on the blocking pool, in the workspace folder.
async fn blocking<T: Send + 'static>(
    ws: &Ws,
    op: impl FnOnce(PathBuf) -> Result<T, GitError> + Send + 'static,
) -> ApiResult<T> {
    let root = ws.jail.root().to_path_buf();
    Ok(tokio::task::spawn_blocking(move || op(root)).await??)
}

fn log(state: &AppState, ws: &Ws, op: &str, paths: usize) {
    state.publish(Event::GitOp { ip: ws.ip.to_string(), op: op.into(), paths });
}

async fn status(ws: Ws) -> ApiResult<Json<Value>> {
    let Some(version) = tokio::task::spawn_blocking(git::version).await? else {
        return Ok(Json(json!({ "available": false, "repo": false })));
    };
    match blocking(&ws, |root| git::status(&root)).await {
        Ok(status) => {
            let mut value = serde_json::to_value(status).map_err(|e| ApiError::internal(e.to_string()))?;
            value["available"] = json!(true);
            value["repo"] = json!(true);
            value["version"] = json!(version);
            Ok(Json(value))
        }
        Err(err) if err.code == "not_a_repository" => {
            Ok(Json(json!({ "available": true, "repo": false, "version": version })))
        }
        Err(err) => Err(err),
    }
}

#[derive(Deserialize)]
struct ShowQuery {
    path: String,
    #[serde(rename = "ref", default)]
    reference: String,
}

async fn show(State(state): State<AppState>, ws: Ws, Query(q): Query<ShowQuery>) -> ApiResult<Response> {
    let index = match q.reference.as_str() {
        "INDEX" => true,
        "HEAD" | "" => false,
        _ => return Err(ApiError::bad_request("ref must be HEAD or INDEX")),
    };
    let limit = state.settings.get().max_editor_file_mb.saturating_mul(1024 * 1024);
    let text = blocking(&ws, move |root| git::show(&root, &q.path, index, limit)).await?;
    let exists = text.is_some();
    let mut response = text.unwrap_or_default().into_response();
    let headers = response.headers_mut();
    headers.insert("content-type", HeaderValue::from_static("text/plain; charset=utf-8"));
    headers.insert("x-tendril-exists", HeaderValue::from_static(if exists { "1" } else { "0" }));
    Ok(response)
}

#[derive(Deserialize)]
struct PathsBody {
    paths: Vec<String>,
}

async fn stage(State(state): State<AppState>, ws: Ws, Json(body): Json<PathsBody>) -> ApiResult<Json<Value>> {
    let count = body.paths.len();
    blocking(&ws, move |root| git::stage(&root, &body.paths)).await?;
    log(&state, &ws, "stage", count);
    Ok(Json(json!({ "ok": true })))
}

async fn unstage(State(state): State<AppState>, ws: Ws, Json(body): Json<PathsBody>) -> ApiResult<Json<Value>> {
    let count = body.paths.len();
    blocking(&ws, move |root| git::unstage(&root, &body.paths)).await?;
    log(&state, &ws, "unstage", count);
    Ok(Json(json!({ "ok": true })))
}

async fn discard(State(state): State<AppState>, ws: Ws, Json(body): Json<PathsBody>) -> ApiResult<Json<Value>> {
    let count = body.paths.len();
    blocking(&ws, move |root| git::discard(&root, &body.paths)).await?;
    log(&state, &ws, "discard", count);
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct CommitBody {
    message: String,
    #[serde(default)]
    all: bool,
}

async fn commit(State(state): State<AppState>, ws: Ws, Json(body): Json<CommitBody>) -> ApiResult<Json<Value>> {
    let summary = blocking(&ws, move |root| git::commit(&root, &body.message, body.all)).await?;
    log(&state, &ws, "commit", 0);
    Ok(Json(json!({ "summary": summary })))
}

async fn branches(ws: Ws) -> ApiResult<Json<git::Branches>> {
    Ok(Json(blocking(&ws, |root| git::branches(&root)).await?))
}

#[derive(Deserialize)]
struct CheckoutBody {
    branch: String,
    #[serde(default)]
    remote: bool,
}

async fn checkout(State(state): State<AppState>, ws: Ws, Json(body): Json<CheckoutBody>) -> ApiResult<Json<Value>> {
    blocking(&ws, move |root| git::checkout(&root, &body.branch, body.remote)).await?;
    log(&state, &ws, "checkout", 0);
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct BranchBody {
    name: String,
}

async fn branch(State(state): State<AppState>, ws: Ws, Json(body): Json<BranchBody>) -> ApiResult<Json<Value>> {
    blocking(&ws, move |root| git::create_branch(&root, &body.name)).await?;
    log(&state, &ws, "branch", 0);
    Ok(Json(json!({ "ok": true })))
}

async fn fetch(State(state): State<AppState>, ws: Ws) -> ApiResult<Json<Value>> {
    blocking(&ws, |root| git::fetch(&root)).await?;
    log(&state, &ws, "fetch", 0);
    Ok(Json(json!({ "ok": true })))
}

async fn pull(State(state): State<AppState>, ws: Ws) -> ApiResult<Json<Value>> {
    blocking(&ws, |root| git::pull(&root)).await?;
    log(&state, &ws, "pull", 0);
    Ok(Json(json!({ "ok": true })))
}

async fn push(State(state): State<AppState>, ws: Ws) -> ApiResult<Json<Value>> {
    blocking(&ws, |root| git::push(&root)).await?;
    log(&state, &ws, "push", 0);
    Ok(Json(json!({ "ok": true })))
}
