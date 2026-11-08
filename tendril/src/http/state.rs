//! The state shared by every handler: one `Arc` around all the services.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::ops::Deref;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::config::cli::Scheme;
use crate::config::settings::SettingsStore;
use crate::services::activity::Activity;
use crate::services::auth::Auth;
use crate::services::events::{Bus, Event};
use crate::services::logger::Logger;
use crate::services::shutdown::Shutdown;
use crate::services::terminals::Terminals;
use crate::services::workspaces::Workspaces;

/// Facts about this running instance.
#[derive(Debug, Clone)]
pub struct ServerInfo {
    pub version: &'static str,
    pub scheme: Scheme,
    /// The address actually bound (after the port walk).
    pub addr: SocketAddr,
    pub data_dir: PathBuf,
    /// SHA-256 fingerprint of the certificate (HTTPS only).
    pub fingerprint: Option<String>,
    pub started_ms: u64,
    /// `--password` was given: changing the password in settings.json does
    /// not affect this run.
    pub password_from_cli: bool,
}

impl ServerInfo {
    /// The session cookie name. `__Host-` (HTTPS only) forbids the cookie
    /// from being set by any other host or for any other path.
    pub fn cookie_name(&self) -> &'static str {
        match self.scheme {
            Scheme::Https => "__Host-tendril",
            Scheme::Http => "tendril",
        }
    }
}

/// All services, shared by handlers.
pub struct Services {
    pub info: ServerInfo,
    pub settings: SettingsStore,
    pub logger: Arc<Logger>,
    pub bus: Bus,
    pub auth: Auth,
    pub activity: Activity,
    pub workspaces: Workspaces,
    pub terminals: Terminals,
    pub shutdown: Shutdown,
    /// Requests seen from each blocked IP (to rate-limit their log lines).
    pub blocked_hits: Mutex<HashMap<IpAddr, u64>>,
}

impl Services {
    /// Publishes an event on the bus.
    pub fn publish(&self, event: Event) {
        self.bus.publish(event);
    }
}

/// Cheap-to-clone handle given to every handler.
#[derive(Clone)]
pub struct AppState(pub Arc<Services>);

impl Deref for AppState {
    type Target = Services;

    fn deref(&self) -> &Services {
        &self.0
    }
}
