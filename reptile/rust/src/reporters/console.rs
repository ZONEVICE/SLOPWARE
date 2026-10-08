//! Console reporter: tells the person who started Reptile from a terminal what
//! is happening, without anyone having to open the control panel. A pure
//! subscriber: removing it from `REPORTERS` changes nothing else.

use crate::util::events::{Event, EventBus, Subscription};
use crate::util::logger::Logger;
use std::sync::Arc;

fn sync_message(state: &str) -> Option<&'static str> {
    Some(match state {
        "syncing" => "synchronising with the host\u{2026}",
        "live" => "live: both copies are identical",
        "reconnecting" => "connection lost, reconnecting\u{2026}",
        "pin_required" => "the host changed the PIN; enter the new one in the control panel",
        "stopped" => "the host stopped hosting; syncing ended",
        "error" => "syncing stopped because of an error (see the control panel)",
        _ => return None,
    })
}

pub fn attach(bus: &Arc<EventBus>, logger: &Logger) -> Subscription {
    let log = logger.child("events");
    bus.subscribe(move |event| match event {
        Event::HostingStarted { name, path, .. } => log.info(format_args!("hosting \"{name}\" from {path}")),
        Event::HostingStopped { name, reason, .. } => {
            if reason == "root_missing" {
                log.warn(format_args!("stopped hosting \"{name}\": the directory disappeared"));
            } else {
                log.info(format_args!("stopped hosting \"{name}\""));
            }
        }
        Event::HostingPeerConnected { peer } => log.info(format_args!(
            "{} ({}) connected",
            peer["hostname"].as_str().unwrap_or("?"),
            peer["address"].as_str().unwrap_or("?")
        )),
        Event::HostingPeerDisconnected { peer, reason } => {
            log.info(format_args!("{} disconnected ({reason})", peer["hostname"].as_str().unwrap_or("?")))
        }
        Event::HostingPinChanged { disconnected } => log.info(format_args!(
            "the PIN was changed{}",
            if *disconnected { "; the connected instance was disconnected" } else { "" }
        )),
        Event::SyncState { state, .. } => {
            if let Some(message) = sync_message(state) {
                log.info(format_args!("sync: {message}"));
            }
        }
        _ => {}
    })
}
