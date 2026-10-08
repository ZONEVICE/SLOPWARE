//! The control panel's view of the world: one snapshot on demand, and the
//! same snapshot pushed over server-sent events whenever it changes.

use crate::http::router::{Access, Router};
use crate::http::routes::Deps;
use crate::http::server::Reply;
use std::sync::Arc;

pub fn register(router: &mut Router, deps: &Arc<Deps>) {
    let state = deps.clone();
    router.add("GET", "/api/state", Access::Ui, move |_| Ok(Reply::json(200, &(state.snapshot)())));
    let events = deps.clone();
    router.add("GET", "/api/events", Access::Ui, move |_| Ok(events.sse.handle()));
}
