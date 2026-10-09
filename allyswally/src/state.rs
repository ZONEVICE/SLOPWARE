//! The shared application state, built once at startup and handed to every
//! connection thread behind an `Arc`.
//!
//! Dependencies flow one way into here: `paths`, `store`, `log`, `auth`,
//! `events` are all lower layers this struct wires together. Connection and
//! API code reads the world through `AppState` and never constructs these
//! services itself.

use crate::auth::Auth;
use crate::config::HostConfig;
use crate::events::Hub;
use crate::json::Value;
use crate::log::Logger;
use crate::paths::Paths;
use crate::store::Store;
use crate::win::sysinfo;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

/// Names of the managed MASKED categories, in display order. Adding a category
/// is: one entry here, one default in `seed_defaults`, and a handler that reads
/// and writes it by name.
pub const CATEGORIES: &[&str] = &["shortcuts", "launchers", "clipboard", "scripts"];
pub const CONFIG_FILE: &str = "config.json";

pub struct AppState {
    pub paths: Paths,
    pub store: Store,
    pub logger: Arc<Logger>,
    pub auth: Auth,
    pub hub: Hub,
    pub elevated: bool,
    pub port: u16,
    pub dev_no_auth: bool,
    pub start_instant: Instant,
    pub start_unix: u64,
    pub firewall_ready: AtomicBool,
    pub version: &'static str,
    pub build_date: &'static str,
}

impl AppState {
    /// The live host config as a typed view over the current `config.json`.
    pub fn config_value(&self) -> Value {
        self.store.get(CONFIG_FILE)
    }

    /// Run `f` with a `HostConfig` view over the current config. The value is
    /// held for the closure's duration so the borrow stays valid.
    pub fn with_config<R>(&self, f: impl FnOnce(&HostConfig) -> R) -> R {
        let value = self.config_value();
        f(&HostConfig::new(&value))
    }

    /// Seconds the server process has been running.
    pub fn server_uptime_secs(&self) -> u64 {
        self.start_instant.elapsed().as_secs()
    }

    /// Seconds the host has been up (from the OS tick count).
    pub fn host_uptime_secs(&self) -> u64 {
        sysinfo::uptime_millis() / 1000
    }

    /// The category file name (`shortcuts` → `shortcuts.json`).
    pub fn category_file(category: &str) -> String {
        format!("{category}.json")
    }

    /// True when `category` is a known MASKED category.
    pub fn is_category(category: &str) -> bool {
        CATEGORIES.contains(&category)
    }
}

/// The MASKED file name list, derived from [`CATEGORIES`].
pub fn category_files() -> Vec<String> {
    CATEGORIES.iter().map(|c| AppState::category_file(c)).collect()
}
