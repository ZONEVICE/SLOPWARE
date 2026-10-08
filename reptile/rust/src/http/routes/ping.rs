//! `GET /api/ping`: the discovery handshake.
//!
//! Public on purpose: any instance scanning the network must be able to ask
//! "are you Reptile?". The answer identifies the instance and says whether it
//! is hosting a directory, and which one. Never a path on disk, never the PIN.

use crate::http::router::{Access, Router};
use crate::http::routes::Deps;
use crate::http::server::Reply;
use std::sync::Arc;

pub fn register(router: &mut Router, deps: &Arc<Deps>) {
    let deps = deps.clone();
    router.add("GET", "/api/ping", Access::Public, move |_| Ok(Reply::json(200, &(deps.ping)())));
}
