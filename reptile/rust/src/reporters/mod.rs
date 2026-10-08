//! Event subscriber registry.
//!
//! THIS IS THE LEGO BOARD for features that only need to KNOW what happens
//! (notifications, logs, statistics). A reporter is
//! `fn(&Arc<EventBus>, &Logger) -> Subscription`. To add one, drop a file in
//! this directory and add it to `REPORTERS`; no existing module has to know.

use crate::util::events::{EventBus, Subscription};
use crate::util::logger::Logger;
use std::sync::Arc;

mod console;

pub type Reporter = fn(&Arc<EventBus>, &Logger) -> Subscription;

pub const REPORTERS: &[Reporter] = &[console::attach];

/// Attach every reporter; the subscriptions detach them.
pub fn attach_all(bus: &Arc<EventBus>, logger: &Logger) -> Vec<Subscription> {
    REPORTERS.iter().map(|reporter| reporter(bus, logger)).collect()
}
