//! HTTP route registry.
//!
//! THIS IS THE LEGO BOARD of the HTTP layer. A route module is a plugin
//! `fn register(router, deps)`. To add an endpoint group, drop a file in this
//! directory and add it to `PLUGINS`; nothing else changes.
//!
//! Every route declares who may call it (`Access::Ui` is guarded,
//! `Access::Peer` checks the PIN or the token itself, `Access::Public` is
//! open). The JSON shapes are the contract with the control panel and with
//! Node.js peers: keep them identical to the Node.js implementation's.

use crate::domain::discovery::Discovery;
use crate::domain::hosting::HostingService;
use crate::domain::identity::Identity;
use crate::domain::modes::ModeController;
use crate::domain::syncing::SyncingService;
use crate::http::router::Router;
use crate::http::sse::SseHub;
use crate::util::logger::Logger;
use serde_json::Value;
use std::sync::Arc;

mod discovery;
mod host;
mod paths;
mod peer;
mod ping;
mod state;
mod sync;

/// Everything a route plugin may use.
pub struct Deps {
    pub identity: Arc<Identity>,
    pub hosting: Arc<HostingService>,
    pub syncing: Arc<SyncingService>,
    pub discovery: Arc<Discovery>,
    pub modes: Arc<ModeController>,
    pub sse: Arc<SseHub>,
    pub logger: Logger,
    pub snapshot: Arc<dyn Fn() -> Value + Send + Sync>,
    pub ping: Arc<dyn Fn() -> Value + Send + Sync>,
}

pub type Plugin = fn(&mut Router, &Arc<Deps>);

/// Every route plugin, in registration order.
pub const PLUGINS: &[Plugin] = &[
    ping::register,
    peer::register,
    state::register,
    discovery::register,
    paths::register,
    host::register,
    sync::register,
];

pub fn register_all(router: &mut Router, deps: &Arc<Deps>) {
    for plugin in PLUGINS {
        plugin(router, deps);
    }
}
