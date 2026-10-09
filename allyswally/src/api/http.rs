//! HTTP management endpoints.
//!
//! Static assets and the PIN endpoint are served unauthenticated; everything
//! under `/api/` else requires a valid session token in the `X-Token` header.
//! Each endpoint is one arm of [`handle`]; the body is parsed as JSON where
//! needed through [`json_body`].

use super::{bundle, host, items, run, ClientInfo};
use crate::auth::AuthError;
use crate::config::{data_dir_display, HostConfig};
use crate::frontend;
use crate::http::{Request, Response};
use crate::json::{self, Obj, Value};
use crate::log::Level;
use crate::state::AppState;
use crate::win::shell;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Entry point for every HTTP request that is not a WebSocket upgrade.
pub fn handle(state: &Arc<AppState>, req: &Request, client: &ClientInfo) -> Response {
    // Static assets (and `/`) are public.
    if req.method == "GET" {
        if let Some(asset) = frontend::lookup(&req.path) {
            let etag = frontend::etag(asset.bytes);
            if req.header("if-none-match") == Some(etag.as_str()) {
                return Response::not_modified(&etag);
            }
            return Response::asset(asset.content_type(), &etag, asset.bytes.to_vec());
        }
    }

    // The PIN endpoint is the only public API route.
    if req.path == "/api/pin" && req.method == "POST" {
        return pin(state, req, client);
    }

    // Everything else under /api requires authentication.
    if req.path.starts_with("/api/") {
        if !state.dev_no_auth && !client.authenticated(state) {
            return Response::unauthorized();
        }
        return api(state, req, client);
    }

    Response::not_found()
}

fn api(state: &Arc<AppState>, req: &Request, client: &ClientInfo) -> Response {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/bootstrap") => {
            maybe_hot_reload(state);
            Response::ok_json(host::bootstrap(state, client.token.as_deref()).to_string())
        }
        ("GET", "/api/host") => {
            Response::ok_json(host::host_info(state, client.token.as_deref()).to_string())
        }
        ("GET", "/api/masked") => masked_list(state, req),
        ("POST", "/api/masked/save") => masked_save(state, req),
        ("POST", "/api/masked/delete") => masked_delete(state, req),
        ("POST", "/api/masked/reorder") => masked_reorder(state, req),
        ("POST", "/api/run") => masked_run(state, req),
        ("GET", "/api/config") => Response::ok_json(state.config_value().to_string()),
        ("POST", "/api/config") => config_save(state, req),
        ("GET", "/api/diagnostics") => diagnostics(state, req),
        ("POST", "/api/latency") => latency(),
        ("POST", "/api/power") => power(state, req),
        ("POST", "/api/server") => server_action(state, req, client),
        ("GET", "/api/export") => export(state),
        ("POST", "/api/import") => import(state, req),
        ("POST", "/api/reset") => reset(state, req),
        ("POST", "/api/open-data-folder") => open_data_folder(state),
        ("POST", "/api/logout") => logout(state, client),
        _ => Response::not_found(),
    }
}

// --- Authentication --------------------------------------------------------

fn pin(state: &Arc<AppState>, req: &Request, client: &ClientInfo) -> Response {
    let body = match json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let attempt = body.get_str("pin").unwrap_or("");
    match state.auth.verify_pin(client.ip, attempt, &client.user_agent) {
        Ok(token) => {
            state.logger.info(
                "auth.ok",
                vec![("ip".into(), Value::Str(client.ip.to_string()))],
            );
            Response::ok_json(Obj::new().boolean("ok", true).str("token", token).build().to_string())
        }
        Err(AuthError::Wrong { remaining }) => {
            state.logger.warn(
                "auth.fail",
                vec![
                    ("ip".into(), Value::Str(client.ip.to_string())),
                    ("remaining".into(), Value::Num(remaining as f64)),
                ],
            );
            Response::json(
                403,
                "Forbidden",
                Obj::new()
                    .boolean("ok", false)
                    .str("error", "wrong")
                    .num("remaining", remaining as f64)
                    .build()
                    .to_string(),
            )
        }
        Err(AuthError::Locked) => {
            state.logger.warn(
                "auth.locked",
                vec![("ip".into(), Value::Str(client.ip.to_string()))],
            );
            Response::too_many()
        }
    }
}

fn logout(state: &Arc<AppState>, client: &ClientInfo) -> Response {
    if let Some(token) = &client.token {
        state.auth.logout(token);
    }
    ok()
}

// --- MASKED CRUD -----------------------------------------------------------

fn masked_list(state: &Arc<AppState>, req: &Request) -> Response {
    maybe_hot_reload(state);
    let category = match req.query_param("category") {
        Some(c) if AppState::is_category(c) => c,
        _ => return Response::bad_request("unknown category"),
    };
    Response::ok_json(state.store.get(&AppState::category_file(category)).to_string())
}

fn masked_save(state: &Arc<AppState>, req: &Request) -> Response {
    let body = match json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let category = match body.get_str("category") {
        Some(c) if AppState::is_category(c) => c.to_string(),
        _ => return Response::bad_request("unknown category"),
    };
    let item = match body.get("item").and_then(|v| v.as_object()) {
        Some(o) => o.to_vec(),
        None => return Response::bad_request("item must be an object"),
    };
    let file = AppState::category_file(&category);
    let list = state.store.get(&file);
    let (new_list, id) = items::upsert(&list, item);
    if let Err(e) = state.store.save(&file, new_list.clone()) {
        return Response::text(500, "Internal Server Error", &format!("save failed: {e}"));
    }
    state.logger.info(
        "masked.save",
        vec![
            ("category".into(), Value::Str(category)),
            ("id".into(), Value::Str(id.clone())),
        ],
    );
    broadcast_band(state);
    Response::ok_json(Obj::new().boolean("ok", true).str("id", id).set("list", new_list).build().to_string())
}

fn masked_delete(state: &Arc<AppState>, req: &Request) -> Response {
    let body = match json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let category = match body.get_str("category") {
        Some(c) if AppState::is_category(c) => c.to_string(),
        _ => return Response::bad_request("unknown category"),
    };
    let id = body.get_str("id").unwrap_or("").to_string();
    let file = AppState::category_file(&category);
    let (new_list, removed) = items::remove(&state.store.get(&file), &id);
    if removed {
        if let Err(e) = state.store.save(&file, new_list.clone()) {
            return Response::text(500, "Internal Server Error", &format!("save failed: {e}"));
        }
        state.logger.info(
            "masked.delete",
            vec![
                ("category".into(), Value::Str(category)),
                ("id".into(), Value::Str(id)),
            ],
        );
        broadcast_band(state);
    }
    Response::ok_json(Obj::new().boolean("ok", removed).set("list", new_list).build().to_string())
}

fn masked_reorder(state: &Arc<AppState>, req: &Request) -> Response {
    let body = match json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let category = match body.get_str("category") {
        Some(c) if AppState::is_category(c) => c.to_string(),
        _ => return Response::bad_request("unknown category"),
    };
    let ids: Vec<String> = body
        .get("ids")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let file = AppState::category_file(&category);
    let new_list = items::reorder(&state.store.get(&file), &ids);
    if let Err(e) = state.store.save(&file, new_list.clone()) {
        return Response::text(500, "Internal Server Error", &format!("save failed: {e}"));
    }
    broadcast_band(state);
    Response::ok_json(Obj::new().boolean("ok", true).set("list", new_list).build().to_string())
}

fn masked_run(state: &Arc<AppState>, req: &Request) -> Response {
    let body = match json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let category = body.get_str("category").unwrap_or("");
    let id = body.get_str("id").unwrap_or("");
    Response::ok_json(run::run_item(state, category, id).to_string())
}

// --- Config ----------------------------------------------------------------

fn config_save(state: &Arc<AppState>, req: &Request) -> Response {
    let body = match json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    // Accept either {config:{...}} or the object directly.
    let config = match body.get("config") {
        Some(c) => c.clone(),
        None => body,
    };
    if config.as_object().is_none() {
        return Response::bad_request("config must be an object");
    }
    if let Err(e) = state.store.save(crate::state::CONFIG_FILE, config.clone()) {
        return Response::text(500, "Internal Server Error", &format!("save failed: {e}"));
    }
    // Apply the retention change immediately.
    let retention = HostConfig::new(&config).log_retention_days();
    state.logger.set_retention(retention);
    state.logger.info("config.save", vec![]);
    state.hub.broadcast_text(Obj::new().str("type", "configChanged").build().to_string());
    ok()
}

// --- Diagnostics -----------------------------------------------------------

fn diagnostics(state: &Arc<AppState>, req: &Request) -> Response {
    let limit = req
        .query_param("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(200)
        .min(500);
    let level = req.query_param("level").and_then(Level::parse);
    let logs = Value::Array(state.logger.recent(limit, level));
    let errors: Vec<Value> = state
        .store
        .errors()
        .into_iter()
        .map(|e| {
            Obj::new()
                .str("file", e.file)
                .str("message", e.message)
                .num("line", e.line as f64)
                .num("column", e.column as f64)
                .build()
        })
        .collect();
    Response::ok_json(
        Obj::new()
            .set("logs", logs)
            .set("jsonErrors", Value::Array(errors))
            .build()
            .to_string(),
    )
}

fn latency() -> Response {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    Response::ok_json(Obj::new().boolean("ok", true).num("serverTime", now).build().to_string())
}

// --- Power & server --------------------------------------------------------

fn power(state: &Arc<AppState>, req: &Request) -> Response {
    let body = match json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let action = body.get_str("action").unwrap_or("");
    state.logger.warn(
        "power.action",
        vec![("action".into(), Value::Str(action.to_string()))],
    );
    use crate::win::power as p;
    let ok_done = match action {
        "lock" => p::lock(),
        "monitorOff" => {
            p::monitor_off();
            true
        }
        "suspend" => p::suspend(),
        "reboot" => p::reboot(true),
        "shutdown" => p::shutdown(true),
        _ => return Response::bad_request("unknown power action"),
    };
    Response::ok_json(Obj::new().boolean("ok", ok_done).build().to_string())
}

fn server_action(state: &Arc<AppState>, req: &Request, _client: &ClientInfo) -> Response {
    let body = match json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    match body.get_str("action").unwrap_or("") {
        "regenPin" => {
            let new_pin = state.auth.regenerate_pin();
            state.logger.warn("server.regenPin", vec![]);
            crate::console_ui::print_pin_change(&new_pin);
            state
                .hub
                .broadcast_text(Obj::new().str("type", "kick").str("reason", "pinRegenerated").build().to_string());
            state.hub.kick_all();
            ok()
        }
        "stop" => {
            state.logger.warn("server.stop", vec![]);
            state.hub.kick_all();
            let logger = state.logger.clone();
            // Give the HTTP response a moment to flush, then exit cleanly.
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(250));
                logger.flush();
                std::process::exit(0);
            });
            ok()
        }
        _ => Response::bad_request("unknown server action"),
    }
}

// --- Data ------------------------------------------------------------------

fn export(state: &Arc<AppState>) -> Response {
    let bundle = bundle::export(state);
    Response::new(200, "OK")
        .with_header("Content-Type", "application/json; charset=utf-8")
        .with_header("Content-Disposition", "attachment; filename=\"allyswally-config.json\"")
        .with_header("Cache-Control", "no-store")
        .with_body(bundle.to_pretty().into_bytes())
}

fn import(state: &Arc<AppState>, req: &Request) -> Response {
    let body = match json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let mode = match body.get_str("mode").and_then(bundle::ImportMode::parse) {
        Some(m) => m,
        None => return Response::bad_request("mode must be combine or replace"),
    };
    let data = match body.get("data") {
        Some(d) => d,
        None => return Response::bad_request("missing data"),
    };
    match bundle::import(state, mode, data) {
        Ok(written) => {
            state.logger.warn(
                "data.import",
                vec![("files".into(), Value::Num(written.len() as f64))],
            );
            broadcast_band(state);
            state.hub.broadcast_text(Obj::new().str("type", "configChanged").build().to_string());
            Response::ok_json(Obj::new().boolean("ok", true).num("files", written.len() as f64).build().to_string())
        }
        Err(e) => Response::text(500, "Internal Server Error", &format!("import failed: {e}")),
    }
}

fn reset(state: &Arc<AppState>, req: &Request) -> Response {
    let body = match json_body(req) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    match body.get_str("target").unwrap_or("") {
        "host" => match bundle::reset_host(state) {
            Ok(()) => {
                state.logger.warn("data.resetHost", vec![]);
                broadcast_band(state);
                state.hub.broadcast_text(Obj::new().str("type", "configChanged").build().to_string());
                ok()
            }
            Err(e) => Response::text(500, "Internal Server Error", &format!("reset failed: {e}")),
        },
        _ => Response::bad_request("unknown reset target"),
    }
}

fn open_data_folder(state: &Arc<AppState>) -> Response {
    let dir = data_dir_display();
    let ok_done = shell::open(&dir.to_string_lossy(), None);
    state.logger.info("data.openFolder", vec![]);
    Response::ok_json(Obj::new().boolean("ok", ok_done).build().to_string())
}

// --- helpers ---------------------------------------------------------------

/// Parse a request body as a JSON object, or produce a 400.
fn json_body(req: &Request) -> Result<Value, Response> {
    match json::parse(&req.body_str()) {
        Ok(v) => Ok(v),
        Err(e) => Err(Response::bad_request(&format!("invalid JSON: {e}"))),
    }
}

fn ok() -> Response {
    Response::ok_json(Obj::new().boolean("ok", true).build().to_string())
}

/// Reload any hand-edited files and, if anything changed, refresh every band.
fn maybe_hot_reload(state: &Arc<AppState>) {
    if !state.store.reload_all_changed().is_empty() {
        broadcast_band(state);
    }
}

/// Push the current shortcut band to every connected client.
fn broadcast_band(state: &Arc<AppState>) {
    let band = host::band_items(state);
    let msg = Obj::new().str("type", "bandReload").set("band", band).build();
    state.hub.broadcast_text(msg.to_string());
}
