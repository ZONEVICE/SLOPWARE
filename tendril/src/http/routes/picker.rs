//! The folder picker and opening a workspace.
//!
//! - `GET /api/picker/roots` -> `{roots, home, recent}`
//! - `GET /api/picker/list?path=<absolute>` -> folders only (never files)
//! - `POST /api/workspace/open {path}` -> `{id, root, name}`
//! - `GET /api/workspace` (with a workspace id) -> `{id, root, name}`; the
//!   browser calls it after a reload to check its id is still valid.

use std::path::PathBuf;

use axum::Json;
use axum::extract::{Query, State};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::{Value, json};

use super::super::error::ApiResult;
use super::super::guard::{Authed, Ws};
use super::super::state::AppState;
use super::Routes;
use crate::config::paths;
use crate::services::events::Event;
use crate::services::files::jail::{self, Jail};
use crate::services::files::picker;

/// Registers the routes.
pub fn register(mut routes: Routes) -> Routes {
    routes.private = routes
        .private
        .route("/api/picker/roots", get(roots))
        .route("/api/picker/list", get(list))
        .route("/api/workspace/open", post(open))
        .route("/api/workspace", get(current));
    routes
}

async fn roots(State(state): State<AppState>, _authed: Authed) -> Json<Value> {
    let home = paths::home_dir().map(|h| jail::display(&h));
    Json(json!({
        "roots": picker::roots(),
        "home": home,
        "recent": state.workspaces.recent(),
        "separator": std::path::MAIN_SEPARATOR.to_string(),
    }))
}

#[derive(Deserialize)]
struct ListQuery {
    path: String,
}

async fn list(_authed: Authed, Query(q): Query<ListQuery>) -> ApiResult<Json<picker::Listing>> {
    let listing = tokio::task::spawn_blocking(move || picker::list(&q.path)).await??;
    Ok(Json(listing))
}

#[derive(Deserialize)]
struct OpenBody {
    path: String,
}

fn describe(id: &str, jail: &Jail) -> Value {
    let root = jail.display_root();
    let name = jail.root().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.clone());
    json!({ "id": id, "root": root, "name": name })
}

async fn open(State(state): State<AppState>, authed: Authed, Json(body): Json<OpenBody>) -> ApiResult<Json<Value>> {
    let registry = state.clone();
    let path = PathBuf::from(&body.path);
    let workspace = tokio::task::spawn_blocking(move || registry.workspaces.open(authed.session, &path)).await??;
    state.publish(Event::WorkspaceOpened { ip: authed.ip.to_string(), path: workspace.jail.display_root() });
    Ok(Json(describe(&workspace.id, &workspace.jail)))
}

async fn current(ws: Ws) -> Json<Value> {
    Json(describe(&ws.id, &ws.jail))
}
