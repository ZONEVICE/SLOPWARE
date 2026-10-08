//! All business rules: hosting, syncing, discovery, selection, the planner,
//! the PIN, the single-mode rule and the protocol's names. The domain never
//! imports a transport; `transport` declares what it needs and `app` injects
//! the implementations.

pub mod activity;
pub mod discovery;
pub mod errors;
pub mod hosting;
pub mod identity;
pub mod modes;
pub mod pin;
pub mod planner;
pub mod protocol;
pub mod selection;
pub mod syncing;
pub mod transport;
