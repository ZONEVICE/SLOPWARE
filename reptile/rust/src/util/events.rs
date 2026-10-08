//! Minimal synchronous event bus.
//!
//! ARCHITECTURE NOTE (read this before adding features):
//! The bus is the seam between the rules and the outside world. The discovery,
//! hosting and syncing services never talk to a browser: they publish an event
//! here and whoever cares subscribes. The server-sent-events hub that keeps the
//! interface live is one subscriber; the console reporter is another. A new
//! feature can listen to existing events without a single existing module
//! knowing about it.
//!
//! Events are delivered synchronously, in subscription order, on the thread
//! that publishes them. Two rules keep that safe with threads:
//!   - services publish AFTER releasing their own locks;
//!   - subscribers never call back into a service that takes a lock; they
//!     record what they need and return (the SSE hub only flags itself dirty).
//!
//! A panicking subscriber is caught and logged; the rest still run.

use crate::util::threads::Locked;
use serde_json::Value;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Every published event. Adding a variant is the only way to publish
/// something new; there are no free-form event names.
#[derive(Debug, Clone)]
pub enum Event {
    /// Something the interface displays changed.
    StateChanged {
        section: &'static str,
    },
    /// The single-mode controller switched modes.
    ModeChanged {
        from: &'static str,
        to: &'static str,
    },
    /// A new entry was appended to an activity log.
    Activity {
        source: &'static str,
        entry: Value,
    },
    HostingStarted {
        name: String,
        path: String,
        id: String,
    },
    HostingStopped {
        name: String,
        id: String,
        reason: String,
    },
    HostingPinChanged {
        disconnected: bool,
    },
    HostingPeerConnected {
        peer: Value,
    },
    HostingPeerDisconnected {
        reason: String,
        peer: Value,
    },
    /// The syncing engine moved to another connection state.
    SyncState {
        state: &'static str,
        previous: &'static str,
    },
    /// Discovery found, updated or lost instances.
    DiscoveryUpdated,
}

type Listener = Arc<dyn Fn(&Event) + Send + Sync>;

pub struct EventBus {
    listeners: Mutex<Vec<(u64, Listener)>>,
    next_id: AtomicU64,
    on_error: Box<dyn Fn(&str) + Send + Sync>,
}

/// Returned by `subscribe`; call `off` to stop listening.
pub struct Subscription {
    bus: std::sync::Weak<EventBus>,
    id: u64,
}

impl Subscription {
    pub fn off(self) {
        if let Some(bus) = self.bus.upgrade() {
            bus.listeners.locked().retain(|(id, _)| *id != self.id);
        }
    }
}

impl EventBus {
    pub fn new(on_error: impl Fn(&str) + Send + Sync + 'static) -> Arc<EventBus> {
        Arc::new(EventBus {
            listeners: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(1),
            on_error: Box::new(on_error),
        })
    }

    pub fn subscribe(self: &Arc<Self>, listener: impl Fn(&Event) + Send + Sync + 'static) -> Subscription {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.listeners.locked().push((id, Arc::new(listener)));
        Subscription { bus: Arc::downgrade(self), id }
    }

    pub fn emit(&self, event: Event) {
        // Copy first: a listener may unsubscribe itself during delivery.
        let listeners: Vec<Listener> = self.listeners.locked().iter().map(|(_, l)| l.clone()).collect();
        for listener in listeners {
            if catch_unwind(AssertUnwindSafe(|| listener(&event))).is_err() {
                (self.on_error)(&format!("a listener for {event:?} panicked"));
            }
        }
    }

    /// Shorthand for the most common event.
    pub fn changed(&self, section: &'static str) {
        self.emit(Event::StateChanged { section });
    }

    /// Drop every subscription (shutdown).
    pub fn clear(&self) {
        self.listeners.locked().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn delivers_in_order_and_survives_a_panicking_listener() {
        let errors = Arc::new(AtomicUsize::new(0));
        let counter = errors.clone();
        let bus = EventBus::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        let seen = Arc::new(Mutex::new(Vec::new()));
        let first = seen.clone();
        bus.subscribe(move |_| first.locked().push(1));
        bus.subscribe(|_| panic!("boom"));
        let third = seen.clone();
        let sub = bus.subscribe(move |_| third.locked().push(3));
        bus.changed("test");
        assert_eq!(*seen.locked(), vec![1, 3]);
        assert_eq!(errors.load(Ordering::SeqCst), 1);
        sub.off();
        bus.changed("test");
        assert_eq!(*seen.locked(), vec![1, 3, 1]);
    }
}
