//! Discovery: a continuous background scan of the local network for other
//! Reptile instances, Rust or Node.js alike.
//!
//! Two independent loops run while scanning is enabled:
//!
//!  - the SWEEP walks every scan target in two phases so that a /24 with a
//!    single computer on it does not cost 254 x 20 connection attempts: first
//!    the default port on every host, then the remaining ports only on hosts
//!    that answered at all (a closed port answers too), on this machine's own
//!    addresses, and on hosts seen recently.
//!  - the REFRESH re-pings every known instance every few seconds and forgets
//!    instances that stopped answering.
//!
//! The probe itself is injected by the composition root.

use crate::domain::identity::Identity;
use crate::domain::transport::{Probe, ProbeOptions, ProbeStatus};
use crate::util::events::{Event, EventBus};
use crate::util::logger::Logger;
use crate::util::net::{default_scan_hosts, format_port_ranges, is_loopback_address, local_addresses};
use crate::util::threads::Locked;
use crate::util::threads::{run_pool, spawn, Sleeper};
use crate::util::time::now_ms;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct DiscoverySettings {
    pub enabled: bool,
    /// None: the /24 of every LAN interface, plus loopback.
    pub hosts: Option<Vec<String>>,
    pub ports: Vec<u16>,
    pub concurrency: usize,
    pub connect_timeout_ms: u64,
    pub request_timeout_ms: u64,
    /// Pause between two sweeps of the whole subnet.
    pub sweep_interval_ms: u64,
    /// Known instances are re-pinged this often.
    pub refresh_interval_ms: u64,
    /// An instance silent for this long leaves the list.
    pub stale_ms: i64,
    /// A host that answered is scanned on every port for this long.
    pub alive_memory_ms: i64,
}

#[derive(Default)]
struct State {
    instances: HashMap<String, Value>,
    alive_hosts: HashMap<String, i64>,
    enabled: bool,
    scanning: bool,
    sweeps: u64,
    last_sweep_at: Option<i64>,
    last_sweep_ms: Option<i64>,
    last_host_count: usize,
}

struct Run {
    cancelled: Arc<AtomicBool>,
    sweep_sleeper: Arc<Sleeper>,
    refresh_sleeper: Arc<Sleeper>,
}

pub struct Discovery {
    settings: DiscoverySettings,
    identity: Arc<Identity>,
    bus: Arc<EventBus>,
    probe: Probe,
    logger: Logger,
    st: Mutex<State>,
    run: Mutex<Option<Run>>,
}

/// Everything the interface shows, minus timestamps.
fn signature(record: &Value) -> Value {
    json!([
        record["hostname"],
        record["address"],
        record["port"],
        record["protocol"],
        record["mode"],
        record["hosting"]
    ])
}

impl Discovery {
    pub fn new(
        settings: DiscoverySettings,
        identity: Arc<Identity>,
        bus: Arc<EventBus>,
        probe: Probe,
        logger: Logger,
    ) -> Arc<Discovery> {
        Arc::new(Discovery {
            settings,
            identity,
            bus,
            probe,
            logger,
            st: Mutex::new(State::default()),
            run: Mutex::new(None),
        })
    }

    fn announce(&self) {
        self.bus.emit(Event::DiscoveryUpdated);
        self.bus.changed("discovery");
    }

    fn targets(&self) -> Vec<String> {
        match &self.settings.hosts {
            Some(hosts) if !hosts.is_empty() => hosts.clone(),
            _ => default_scan_hosts(&self.identity.interfaces()),
        }
    }

    /// Public record for the interface and the ping comparison.
    fn to_record(&self, info: &Value, existing: Option<&Value>) -> Value {
        let now = now_ms();
        let mut address = info["address"].as_str().unwrap_or("").to_string();
        // An instance on this machine answers on loopback and on the LAN
        // address; keep the LAN address, the one the user recognises.
        if let Some(previous) = existing.and_then(|e| e["address"].as_str()) {
            if previous != address && is_loopback_address(&address) && !is_loopback_address(previous) {
                address = previous.to_string();
            }
        }
        let hosting = match info.get("hosting") {
            Some(h) if h.is_object() => json!({
                "id": h.get("id").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null),
                "name": h.get("name").and_then(Value::as_str).unwrap_or(""),
                "connected": h.get("connected").and_then(Value::as_bool).unwrap_or(false),
            }),
            _ => Value::Null,
        };
        let protocol = info["protocol"].as_str().unwrap_or("").to_string();
        let mode = match info.get("mode").and_then(Value::as_str) {
            Some(mode) if !mode.is_empty() => mode.to_string(),
            _ => if hosting.is_null() { "idle" } else { "hosting" }.to_string(),
        };
        json!({
            "uuid": info["uuid"],
            "hostname": info.get("hostname").and_then(Value::as_str).filter(|h| !h.is_empty()).unwrap_or("unknown"),
            "address": address,
            "port": info.get("port").and_then(Value::as_u64).unwrap_or(0),
            "protocol": protocol,
            "version": info.get("version").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null),
            "mode": mode,
            "hosting": hosting,
            "compatible": protocol == self.identity.protocol,
            "firstSeen": existing.and_then(|e| e.get("firstSeen").cloned()).unwrap_or(json!(now)),
            "lastSeen": now,
        })
    }

    fn upsert(&self, info: &Value) {
        let Some(uuid) = info.get("uuid").and_then(Value::as_str) else { return };
        if uuid == self.identity.uuid {
            return; // never list ourselves
        }
        let changed = {
            let mut st = self.st.locked();
            let existing = st.instances.get(uuid).cloned();
            let record = self.to_record(info, existing.as_ref());
            let changed = existing.map(|e| signature(&e) != signature(&record)).unwrap_or(true);
            st.instances.insert(uuid.to_string(), record);
            changed
        };
        if changed {
            self.announce();
        }
    }

    fn prune(&self) {
        let changed = {
            let mut st = self.st.locked();
            let now = now_ms();
            let before = st.instances.len();
            st.instances.retain(|_, record| now - record["lastSeen"].as_i64().unwrap_or(0) <= self.settings.stale_ms);
            st.instances.len() != before
        };
        if changed {
            self.announce();
        }
    }

    fn options(&self, host: &str, port: u16, cancelled: &Arc<AtomicBool>) -> ProbeOptions {
        ProbeOptions {
            host: host.to_string(),
            port,
            prefer_protocol: self.identity.protocol.to_string(),
            connect_timeout_ms: self.settings.connect_timeout_ms,
            request_timeout_ms: self.settings.request_timeout_ms,
            skip_tcp_check: false,
            cancelled: Some(cancelled.clone()),
        }
    }

    fn probe_one(&self, host: &str, port: u16, cancelled: &Arc<AtomicBool>) {
        if cancelled.load(Ordering::SeqCst) {
            return;
        }
        let result = (self.probe)(&self.options(host, port, cancelled));
        if cancelled.load(Ordering::SeqCst) {
            return;
        }
        if result.reachable {
            self.st.locked().alive_hosts.insert(host.to_string(), now_ms());
        }
        if result.status == ProbeStatus::Found {
            if let Some(info) = &result.info {
                self.upsert(info);
            }
        }
    }

    fn sweep(&self, cancelled: &Arc<AtomicBool>) {
        let started = now_ms();
        let hosts = self.targets();
        let ports = self.settings.ports.clone();
        self.st.locked().last_host_count = hosts.len();
        if ports.is_empty() || hosts.is_empty() {
            return;
        }
        self.st.locked().scanning = true;
        self.announce();

        let own = local_addresses(&self.identity.interfaces());
        let answered = Mutex::new(HashSet::new());
        let first = ports[0];
        let stop = || cancelled.load(Ordering::SeqCst);
        run_pool(&hosts, self.settings.concurrency, &stop, &|host: &String| -> Result<(), ()> {
            let before = self.st.locked().alive_hosts.get(host).copied().unwrap_or(0);
            self.probe_one(host, first, cancelled);
            let after = self.st.locked().alive_hosts.get(host).copied().unwrap_or(0);
            if after > before {
                answered.locked().insert(host.clone());
            }
            Ok(())
        });

        let recent = now_ms() - self.settings.alive_memory_ms;
        let answered = answered.into_inner().unwrap();
        let second_phase: Vec<String> = {
            let st = self.st.locked();
            hosts
                .iter()
                .filter(|host| {
                    answered.contains(*host)
                        || own.contains(*host)
                        || is_loopback_address(host)
                        || st.alive_hosts.get(*host).copied().unwrap_or(0) > recent
                })
                .cloned()
                .collect()
        };
        let pairs: Vec<(String, u16)> =
            second_phase.iter().flat_map(|host| ports[1..].iter().map(move |port| (host.clone(), *port))).collect();
        run_pool(&pairs, self.settings.concurrency, &stop, &|(host, port): &(String, u16)| -> Result<(), ()> {
            self.probe_one(host, *port, cancelled);
            Ok(())
        });

        {
            let mut st = self.st.locked();
            if !cancelled.load(Ordering::SeqCst) {
                st.sweeps += 1;
                let now = now_ms();
                st.last_sweep_at = Some(now);
                st.last_sweep_ms = Some(now - started);
            }
            st.scanning = false;
        }
        self.announce();
    }

    fn refresh(&self, cancelled: &Arc<AtomicBool>) {
        let known: Vec<Value> = self.st.locked().instances.values().cloned().collect();
        let stop = || cancelled.load(Ordering::SeqCst);
        run_pool(&known, 8, &stop, &|record: &Value| -> Result<(), ()> {
            let host = record["address"].as_str().unwrap_or("");
            let port = record["port"].as_u64().unwrap_or(0) as u16;
            let mut options = self.options(host, port, cancelled);
            options.skip_tcp_check = true;
            options.prefer_protocol = record["protocol"].as_str().unwrap_or("http").to_string();
            let result = (self.probe)(&options);
            if !cancelled.load(Ordering::SeqCst) && result.status == ProbeStatus::Found {
                if let Some(info) = &result.info {
                    self.upsert(info);
                }
            }
            Ok(())
        });
        if !cancelled.load(Ordering::SeqCst) {
            self.prune();
        }
    }

    fn begin(self: &Arc<Self>) {
        let cancelled = Arc::new(AtomicBool::new(false));
        let sweep_sleeper = Sleeper::new();
        let refresh_sleeper = Sleeper::new();
        {
            let (me, cancelled, sleeper) = (self.clone(), cancelled.clone(), sweep_sleeper.clone());
            spawn("discovery-sweep", move || {
                while !cancelled.load(Ordering::SeqCst) {
                    me.sweep(&cancelled);
                    if cancelled.load(Ordering::SeqCst)
                        || !sleeper.sleep(Duration::from_millis(me.settings.sweep_interval_ms))
                    {
                        break;
                    }
                }
                if cancelled.load(Ordering::SeqCst) {
                    me.st.locked().scanning = false;
                }
            });
        }
        {
            let (me, cancelled, sleeper) = (self.clone(), cancelled.clone(), refresh_sleeper.clone());
            spawn("discovery-refresh", move || {
                while sleeper.sleep(Duration::from_millis(me.settings.refresh_interval_ms))
                    && !cancelled.load(Ordering::SeqCst)
                {
                    me.refresh(&cancelled);
                }
            });
        }
        *self.run.locked() = Some(Run { cancelled, sweep_sleeper, refresh_sleeper });
    }

    fn halt(&self) {
        if let Some(run) = self.run.locked().take() {
            run.cancelled.store(true, Ordering::SeqCst);
            run.sweep_sleeper.stop();
            run.refresh_sleeper.stop();
        }
        self.st.locked().scanning = false;
    }

    /// Start scanning if the configuration enables it at startup.
    pub fn start(self: &Arc<Self>) {
        if self.settings.enabled {
            self.set_enabled(true);
        }
    }

    /// Turn the background scan on or off (the status bar button).
    pub fn set_enabled(self: &Arc<Self>, value: bool) -> Value {
        {
            let mut st = self.st.locked();
            if st.enabled == value {
                drop(st);
                return self.status();
            }
            st.enabled = value;
        }
        if value {
            self.begin();
        } else {
            self.halt();
        }
        self.announce();
        self.status()
    }

    /// Start the next sweep now instead of waiting for the interval.
    pub fn scan_now(&self) -> Value {
        if self.st.locked().enabled {
            if let Some(run) = self.run.locked().as_ref() {
                run.sweep_sleeper.wake();
            }
        }
        self.status()
    }

    /// Discovered instances, never including this one.
    pub fn list(&self) -> Vec<Value> {
        let mut list: Vec<Value> = self.st.locked().instances.values().cloned().collect();
        list.sort_by(|a, b| {
            let text = |v: &Value, k: &str| v[k].as_str().unwrap_or("").to_lowercase();
            text(a, "hostname")
                .cmp(&text(b, "hostname"))
                .then_with(|| text(a, "address").cmp(&text(b, "address")))
                .then_with(|| a["port"].as_u64().cmp(&b["port"].as_u64()))
        });
        list
    }

    pub fn status(&self) -> Value {
        let ports = &self.settings.ports;
        let instances = self.list();
        let st = self.st.locked();
        json!({
            "enabled": st.enabled,
            "scanning": st.scanning,
            "sweeps": st.sweeps,
            "lastSweepAt": st.last_sweep_at,
            "lastSweepMs": st.last_sweep_ms,
            "hosts": st.last_host_count,
            "ports": if ports.is_empty() { Value::Null } else { json!({ "ranges": format_port_ranges(ports), "count": ports.len() }) },
            "instances": instances,
        })
    }

    /// Stop every loop; used at shutdown.
    pub fn stop(&self) {
        self.st.locked().enabled = false;
        self.halt();
        self.logger.debug("discovery stopped");
    }
}
