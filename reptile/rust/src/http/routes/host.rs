//! Hosting controls for the control panel: start, change the PIN, stop.

use crate::domain::pin::generate_pin;
use crate::http::router::{Access, Router};
use crate::http::routes::Deps;
use crate::http::server::Reply;
use serde_json::json;
use std::sync::Arc;

pub fn register(router: &mut Router, deps: &Arc<Deps>) {
    router.add("GET", "/api/host/pin/suggest", Access::Ui, |_| Ok(Reply::json(200, &json!({ "pin": generate_pin() }))));

    let start = deps.clone();
    router.add("POST", "/api/host", Access::Ui, move |request| {
        let body = request.read_json(16 * 1024 * 1024)?;
        let status = start.modes.start_hosting(&body)?;
        start.sse.flush();
        Ok(Reply::json(201, &status))
    });

    let pin = deps.clone();
    router.add("POST", "/api/host/pin", Access::Ui, move |request| {
        let body = request.read_json(1024 * 1024)?;
        let result = pin.modes.set_host_pin(body.get("pin"))?;
        pin.sse.flush();
        Ok(Reply::json(200, &result))
    });

    let stop = deps.clone();
    router.add("DELETE", "/api/host", Access::Ui, move |_| {
        stop.modes.stop_hosting();
        stop.sse.flush();
        Ok(Reply::json(200, &json!({ "ok": true })))
    });
}
