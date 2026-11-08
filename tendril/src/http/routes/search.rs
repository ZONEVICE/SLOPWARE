//! Workspace search.
//!
//! - `GET /api/fs/files` -> `{files, truncated}`: every file path, for the
//!   fuzzy "Go to File" picker (filtered in the browser).
//! - `POST /api/fs/grep {query, case_sensitive, whole_word, include}` ->
//!   matches per file, for "Find in Files".

use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::routing::{get, post};
use serde::Deserialize;

use super::super::error::ApiResult;
use super::super::guard::Ws;
use super::super::state::AppState;
use super::Routes;
use crate::services::files::search::{self, FileList, GrepResult, Query};

/// Paths returned by `files` at most.
pub const MAX_FILES: usize = 20_000;
/// Matching lines returned by `grep` at most.
pub const MAX_MATCHES: usize = 2_000;

/// Registers the routes.
pub fn register(mut routes: Routes) -> Routes {
    routes.private = routes.private.route("/api/fs/files", get(files)).route("/api/fs/grep", post(grep));
    routes
}

async fn files(State(state): State<AppState>, ws: Ws) -> ApiResult<Json<FileList>> {
    let settings = state.settings.get();
    let jail = ws.jail.clone();
    let list = tokio::task::spawn_blocking(move || {
        search::list_files(&jail, &settings.search_exclude, settings.ui.show_hidden_files, MAX_FILES)
    })
    .await?;
    Ok(Json(list))
}

#[derive(Deserialize)]
struct GrepBody {
    query: String,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    whole_word: bool,
    #[serde(default)]
    include: String,
}

async fn grep(State(state): State<AppState>, ws: Ws, Json(body): Json<GrepBody>) -> ApiResult<Json<GrepResult>> {
    let settings = state.settings.get();
    let jail = ws.jail.clone();
    let query = Query {
        needle: body.query,
        case_sensitive: body.case_sensitive,
        whole_word: body.whole_word,
        include: body.include,
        max_matches: MAX_MATCHES,
        budget: Duration::from_secs(10),
    };
    let result = tokio::task::spawn_blocking(move || {
        search::grep(&jail, &settings.search_exclude, settings.ui.show_hidden_files, &query)
    })
    .await??;
    Ok(Json(result))
}
