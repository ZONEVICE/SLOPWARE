//! The single-mode rule: an instance is hosting, syncing, or neither, never
//! two of those at once.
//!
//! Every transition goes through this controller, serialised by a lock so
//! that two quick clicks cannot interleave a start and a stop. The ordering:
//!
//!  - Starting to sync while hosting first verifies the target and the PIN
//!    (the handshake), and only then stops hosting. A wrong PIN therefore
//!    leaves hosting untouched.
//!  - Starting to host while syncing stops syncing first.
//!  - Hosting another directory requires stopping the current one first.

use crate::domain::errors::{AppError, AppResult};
use crate::domain::hosting::HostingService;
use crate::domain::syncing::SyncingService;
use crate::util::events::{Event, EventBus, Subscription};
use crate::util::threads::Locked;
use serde_json::Value;
use std::sync::{Arc, Mutex};

pub struct ModeController {
    transitions: Mutex<()>,
    mode: Arc<Mutex<&'static str>>,
    bus: Arc<EventBus>,
    hosting: Arc<HostingService>,
    syncing: Arc<SyncingService>,
    subscription: Mutex<Option<Subscription>>,
}

fn set_mode(mode: &Mutex<&'static str>, bus: &EventBus, next: &'static str) {
    let from = {
        let mut current = mode.locked();
        if *current == next {
            return;
        }
        std::mem::replace(&mut *current, next)
    };
    bus.emit(Event::ModeChanged { from, to: next });
    bus.changed("mode");
}

impl ModeController {
    pub fn new(bus: Arc<EventBus>, hosting: Arc<HostingService>, syncing: Arc<SyncingService>) -> Arc<ModeController> {
        let mode = Arc::new(Mutex::new("idle"));
        let controller = Arc::new(ModeController {
            transitions: Mutex::new(()),
            mode: mode.clone(),
            bus: bus.clone(),
            hosting: hosting.clone(),
            syncing,
            subscription: Mutex::new(None),
        });
        // Hosting can end on its own (the directory disappeared).
        let (listener_bus, weak_hosting) = (Arc::downgrade(&bus), Arc::downgrade(&hosting));
        let subscription = bus.subscribe(move |event| {
            if let Event::HostingStopped { .. } = event {
                let (Some(bus), Some(hosting)) = (listener_bus.upgrade(), weak_hosting.upgrade()) else { return };
                if *mode.locked() == "hosting" && !hosting.active() {
                    set_mode(&mode, &bus, "idle");
                }
            }
        });
        *controller.subscription.locked() = Some(subscription);
        controller
    }

    pub fn mode(&self) -> &'static str {
        *self.mode.locked()
    }

    fn set(&self, next: &'static str) {
        set_mode(&self.mode, &self.bus, next);
    }

    pub fn start_hosting(&self, input: &Value) -> AppResult<Value> {
        let _transition = self.transitions.locked();
        match self.mode() {
            "hosting" => {
                return Err(AppError::conflict(
                    "This instance is already hosting a directory. Stop hosting first.",
                    "already_hosting",
                ))
            }
            "syncing" => {
                self.syncing.stop();
                self.set("idle");
            }
            _ => {}
        }
        let status =
            self.hosting.start(input.get("path"), input.get("name"), input.get("pin"), input.get("excluded"))?;
        self.set("hosting");
        Ok(status)
    }

    pub fn stop_hosting(&self) {
        let _transition = self.transitions.locked();
        self.hosting.stop("stopped");
        if self.mode() == "hosting" {
            self.set("idle");
        }
    }

    pub fn set_host_pin(&self, pin: Option<&Value>) -> AppResult<Value> {
        let _transition = self.transitions.locked();
        if self.mode() != "hosting" {
            return Err(AppError::conflict("This instance is not hosting a directory.", "not_hosting"));
        }
        self.hosting.set_pin(pin)
    }

    pub fn start_syncing(&self, input: &Value) -> AppResult<Value> {
        let _transition = self.transitions.locked();
        if self.mode() == "syncing" {
            return Err(AppError::conflict(
                "This instance is already syncing a directory. Stop syncing first.",
                "already_syncing",
            ));
        }
        let prepared = self.syncing.handshake(
            input.get("address"),
            input.get("port"),
            input.get("localPath"),
            input.get("pin"),
        )?;
        if self.mode() == "hosting" {
            self.hosting.stop("stopped");
            self.set("idle");
        }
        match self.syncing.begin(&prepared) {
            Ok(status) => {
                self.set("syncing");
                Ok(status)
            }
            Err(error) => {
                self.syncing.abandon(&prepared);
                Err(error)
            }
        }
    }

    pub fn stop_syncing(&self) {
        let _transition = self.transitions.locked();
        self.syncing.stop();
        if self.mode() == "syncing" {
            self.set("idle");
        }
    }

    pub fn submit_sync_pin(&self, pin: Option<&Value>) -> AppResult<Value> {
        let _transition = self.transitions.locked();
        if self.mode() != "syncing" {
            return Err(AppError::conflict("This instance is not syncing a directory.", "not_syncing"));
        }
        self.syncing.submit_pin(pin)
    }

    /// Stop whatever is running; used at shutdown.
    pub fn shutdown(&self) {
        let _transition = self.transitions.locked();
        self.syncing.stop();
        self.hosting.stop("stopped");
        self.set("idle");
        if let Some(subscription) = self.subscription.locked().take() {
            subscription.off();
        }
    }
}
