//! Syncing controls for the control panel: inspect a target, connect with a
//! PIN, answer a PIN change, stop.

use crate::http::router::{Access, Router};
use crate::http::routes::Deps;
use crate::http::server::Reply;
use serde_json::json;
use std::sync::Arc;

pub fn register(router: &mut Router, deps: &Arc<Deps>) {
    let inspect = deps.clone();
    router.add("POST", "/api/sync/inspect", Access::Ui, move |request| {
        let body = request.read_json(1024 * 1024)?;
        Ok(Reply::json(200, &inspect.syncing.inspect(body.get("address"), body.get("port"))?))
    });

    let start = deps.clone();
    router.add("POST", "/api/sync", Access::Ui, move |request| {
        let body = request.read_json(1024 * 1024)?;
        let status = start.modes.start_syncing(&body)?;
        start.sse.flush();
        Ok(Reply::json(201, &status))
    });

    let pin = deps.clone();
    router.add("POST", "/api/sync/pin", Access::Ui, move |request| {
        let body = request.read_json(1024 * 1024)?;
        let status = pin.modes.submit_sync_pin(body.get("pin"))?;
        pin.sse.flush();
        Ok(Reply::json(200, &status))
    });

    let stop = deps.clone();
    router.add("DELETE", "/api/sync", Access::Ui, move |_| {
        stop.modes.stop_syncing();
        stop.sse.flush();
        Ok(Reply::json(200, &json!({ "ok": true })))
    });
}
