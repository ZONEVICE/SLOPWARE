//! Who this instance is.
//!
//! The UUID is generated once per process and never stored: a restarted
//! Reptile is a new instance ("no persistence of any kind"). Addresses are read
//! live (cached for a second), because a laptop can change networks while
//! Reptile runs.

use crate::util::ids::new_uuid;
use crate::util::net::{lan_addresses, list_interfaces, machine_fingerprint, primary_address, InterfaceAddress};
use crate::util::sys::hostname;
use crate::util::threads::Locked;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Where the interface table comes from: the real one, or a fixed list (tests).
pub type InterfaceSource = Arc<dyn Fn() -> Vec<InterfaceAddress> + Send + Sync>;

pub fn system_interfaces() -> InterfaceSource {
    Arc::new(list_interfaces)
}

pub struct Identity {
    pub version: String,
    pub uuid: String,
    pub hostname: String,
    pub protocol: &'static str,
    /// Filled in once the server is listening; the port walk decides it.
    port: AtomicU16,
    /// Same value for every instance on this computer, whichever
    /// implementation it runs.
    pub machine: String,
    pub certificate_fingerprint: Mutex<Option<String>>,
    interfaces: InterfaceSource,
    cache: Mutex<Option<(Instant, Vec<InterfaceAddress>)>>,
}

impl Identity {
    pub fn new(protocol: &'static str, interfaces: InterfaceSource) -> Identity {
        let host = hostname();
        let table = interfaces();
        Identity {
            version: env!("REPTILE_VERSION").to_string(),
            uuid: new_uuid(),
            machine: machine_fingerprint(&table, &host),
            hostname: host,
            protocol,
            port: AtomicU16::new(0),
            certificate_fingerprint: Mutex::new(None),
            interfaces,
            cache: Mutex::new(None),
        }
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    pub fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::SeqCst);
    }

    /// The interface table, re-read at most once a second.
    pub fn interfaces(&self) -> Vec<InterfaceAddress> {
        let mut cache = self.cache.locked();
        if let Some((at, table)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(1) {
                return table.clone();
            }
        }
        let table = (self.interfaces)();
        *cache = Some((Instant::now(), table.clone()));
        table
    }

    pub fn interface_source(&self) -> InterfaceSource {
        self.interfaces.clone()
    }

    pub fn address(&self) -> String {
        primary_address(&self.interfaces())
    }

    pub fn addresses(&self) -> Vec<String> {
        lan_addresses(&self.interfaces())
    }

    /// What the status bar shows.
    pub fn to_json(&self) -> Value {
        let table = self.interfaces();
        json!({
            "app": "reptile",
            "version": self.version,
            "uuid": self.uuid,
            "hostname": self.hostname,
            "protocol": self.protocol,
            "port": self.port(),
            "address": primary_address(&table),
            "addresses": lan_addresses(&table),
        })
    }
}
