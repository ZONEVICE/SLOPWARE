//! Discovery controls: the status bar's scan switch, and "scan now".

use crate::domain::errors::AppError;
use crate::http::router::{Access, Router};
use crate::http::routes::Deps;
use crate::http::server::Reply;
use serde_json::Value;
use std::sync::Arc;

pub fn register(router: &mut Router, deps: &Arc<Deps>) {
    let toggle = deps.clone();
    router.add("POST", "/api/discovery", Access::Ui, move |request| {
        let body = request.read_json(1024 * 1024)?;
        let Some(enabled) = body.get("enabled").and_then(Value::as_bool) else {
            return Err(AppError::bad_request("Send { \"enabled\": true } or { \"enabled\": false }.", "bad_request"));
        };
        let status = toggle.discovery.set_enabled(enabled);
        toggle.sse.flush();
        Ok(Reply::json(200, &status))
    });
    let scan = deps.clone();
    router.add("POST", "/api/discovery/scan", Access::Ui, move |_| Ok(Reply::json(200, &scan.discovery.scan_now())));
}
