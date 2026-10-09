// The lower modules (json, ws, http, events, input, …) expose a complete,
// unit-tested API surface — encoders, accessors and verbs — of which the wired
// application currently uses a subset. The unused members are deliberate,
// tested building blocks for the next feature, so crate-wide dead-code is
// allowed rather than peppering each with an attribute.
#![allow(dead_code)]

//! AllySwally — a LAN assistance tool for a Windows handheld: a web GUI served
//! by this Rust binary that turns a phone or tablet into a trackpad, keyboard
//! and power-user command surface for the host.
//!
//! The dependency graph flows one way: `win` (the only unsafe FFI) and the
//! hand-rolled primitives (`json`, `sha1`, `base64`) at the bottom; then the
//! services (`paths`, `store`, `log`, `auth`, `config`, `events`, `input`,
//! `exec`, `firewall`); then the transports (`http`, `ws`, `server`) and the
//! `api` rules they share; `state` wires them together and `main` starts them.
//! See CLAUDE.md for the full map and the extension points.

mod api;
mod auth;
mod base64;
mod config;
mod console_ui;
mod events;
mod exec;
mod firewall;
mod frontend;
mod http;
mod input;
mod json;
mod log;
mod paths;
mod server;
mod sha1;
mod state;
mod store;
mod win;
mod ws;

use crate::config::{default_config, CliArgs, HostConfig, INSTANCE_MUTEX};
use crate::json::Value;
use crate::log::Logger;
use crate::state::{category_files, AppState, CATEGORIES, CONFIG_FILE};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const VERSION: &str = include_str!("../version.txt");
const BUILD_DATE: &str = env!("BUILD_DATE");

fn main() {
    // Console first: UTF-8 + ANSI, per-monitor DPI awareness, window title.
    win::console::enable_ansi();
    win::console::set_dpi_aware();
    win::console::set_title("AllySwally");

    let args = match CliArgs::parse() {
        Ok(a) => a,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };

    // Single instance: a second launch should bow out, not fight for the port.
    let _instance = match win::instance::SingleInstance::acquire(INSTANCE_MUTEX) {
        Ok(guard) => guard,
        Err(()) => {
            eprintln!("AllySwally is already running. Close the other instance first.");
            std::process::exit(1);
        }
    };

    // Data directory and persisted files.
    let paths = match paths::Paths::resolve() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Could not create the data directory: {e}");
            std::process::exit(1);
        }
    };
    let store = store::Store::new(paths.user_data.clone());
    store.ensure(CONFIG_FILE, default_config());
    for category in CATEGORIES {
        seed_category(&store, category);
    }

    // Logger: retention from config, prune old files, start the flusher.
    let retention = HostConfig::new(&store.get(CONFIG_FILE)).log_retention_days();
    let logger = Arc::new(Logger::new(paths.logs.clone(), retention));
    logger.prune();

    let elevated = win::elevation::is_elevated();
    // The debug-only no-auth flag never takes effect in release builds.
    let dev_no_auth = cfg!(debug_assertions) && args.dev_no_auth;

    // Bind the port (walks upward if busy) before building state so the banner
    // and firewall rule use the real port.
    let (listener, port) = match http::bind(args.port) {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("Could not bind a port: {e}");
            std::process::exit(1);
        }
    };

    let state = Arc::new(AppState {
        paths: paths.clone(),
        store,
        logger: logger.clone(),
        auth: auth::Auth::new(),
        hub: events::Hub::new(),
        elevated,
        port,
        dev_no_auth,
        start_instant: Instant::now(),
        start_unix: now_unix(),
        firewall_ready: AtomicBool::new(false),
        version: VERSION,
        build_date: BUILD_DATE,
    });

    // Firewall: create/refresh the inbound rule when elevated and enabled.
    let firewall_auto = state.with_config(|c| c.firewall_auto_rule());
    if elevated && firewall_auto {
        let ok = firewall::ensure_rule(port);
        state.firewall_ready.store(ok, Ordering::Relaxed);
    } else {
        state
            .firewall_ready
            .store(firewall::rule_exists(), Ordering::Relaxed);
    }

    // The startup screen.
    let interfaces = win::net::interfaces();
    console_ui::print_banner(
        &state.auth.pin(),
        port,
        &interfaces,
        elevated,
        state.firewall_ready.load(Ordering::Relaxed),
        &firewall::manual_command(port),
        VERSION,
    );

    log_startup(&state, &interfaces);

    // Background threads: log flusher, file watcher, IP refresher.
    spawn_flusher(logger.clone());
    spawn_file_watcher(state.clone());
    spawn_ip_watcher(state.clone(), interfaces);

    // Serve forever.
    server::run(state, listener);
}

/// Seed a category file with an empty array, except `shortcuts`, which gets a
/// useful default set on first run.
fn seed_category(store: &store::Store, category: &str) {
    let file = AppState::category_file(category);
    let default = if category == "shortcuts" {
        default_shortcuts()
    } else {
        Value::Array(vec![])
    };
    store.ensure(&file, default);
}

/// The default shortcut set created on first run (the user can delete any).
fn default_shortcuts() -> Value {
    let combos: &[(&str, &str)] = &[
        ("Copy", "Ctrl+C"),
        ("Paste", "Ctrl+V"),
        ("Cut", "Ctrl+X"),
        ("Undo", "Ctrl+Z"),
        ("Redo", "Ctrl+Y"),
        ("Select all", "Ctrl+A"),
        ("Alt+Tab", "Alt+Tab"),
        ("Close window", "Alt+F4"),
        ("Close tab", "Ctrl+W"),
        ("Reopen tab", "Ctrl+Shift+T"),
        ("Start menu", "Win"),
        ("Show desktop", "Win+D"),
        ("File Explorer", "Win+E"),
        ("Task view", "Win+Tab"),
        ("Task Manager", "Ctrl+Shift+Esc"),
        ("Snip", "Win+Shift+S"),
        ("Game Bar", "Win+G"),
        ("Lock", "Win+L"),
    ];
    let mut items = Vec::new();
    for (i, (name, combo)) in combos.iter().enumerate() {
        items.push(
            json::Obj::new()
                .str("id", format!("seed-{i:02}"))
                .str("name", *name)
                .str("description", "")
                .str("combo", *combo)
                .boolean("showInBand", i < 6) // first six on the band by default
                .num("order", i as f64)
                .num("createdAt", now_unix() as f64)
                .num("updatedAt", now_unix() as f64)
                .build(),
        );
    }
    Value::Array(items)
}

fn log_startup(state: &Arc<AppState>, interfaces: &[win::net::Interface]) {
    let ips: Vec<Value> = interfaces
        .iter()
        .map(|i| Value::Str(format!("{} ({})", i.ip, i.kind.label())))
        .collect();
    state.logger.info(
        "startup",
        vec![
            ("port".into(), Value::Num(state.port as f64)),
            ("elevated".into(), Value::Bool(state.elevated)),
            ("version".into(), Value::Str(VERSION.to_string())),
            ("interfaces".into(), Value::Array(ips)),
        ],
    );
}

/// Flush buffered log lines to disk once a second.
fn spawn_flusher(logger: Arc<Logger>) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        logger.flush();
    });
}

/// Poll the managed files for hand edits and hot-reload them, telling clients
/// to refresh when something changed. Also re-prunes logs once a day boundary.
fn spawn_file_watcher(state: Arc<AppState>) {
    thread::spawn(move || {
        let mut last_prune = Instant::now();
        loop {
            thread::sleep(Duration::from_millis(1500));
            let reloaded = state.store.reload_all_changed();
            if !reloaded.is_empty() {
                let band = api::host::band_items(&state);
                state.hub.broadcast_text(
                    json::Obj::new().str("type", "bandReload").set("band", band).build().to_string(),
                );
                if reloaded.iter().any(|n| n == CONFIG_FILE) {
                    let retention =
                        HostConfig::new(&state.config_value()).log_retention_days();
                    state.logger.set_retention(retention);
                    state.hub.broadcast_text(
                        json::Obj::new().str("type", "configChanged").build().to_string(),
                    );
                }
                state.logger.info(
                    "data.reload",
                    vec![("files".into(), Value::Str(reloaded.join(", ")))],
                );
            }
            // Prune logs roughly once a day.
            if last_prune.elapsed() > Duration::from_secs(86_400) {
                state.logger.prune();
                last_prune = Instant::now();
            }
            let _ = category_files(); // keep helper referenced
        }
    });
}

/// Watch for network changes (a Bluetooth PAN link appears after startup, Wi-Fi
/// drops, etc.) and reflect them on the console and in the log.
fn spawn_ip_watcher(state: Arc<AppState>, initial: Vec<win::net::Interface>) {
    thread::spawn(move || {
        let mut previous = initial;
        loop {
            thread::sleep(Duration::from_secs(5));
            let current = win::net::interfaces();
            if current != previous {
                console_ui::print_address_change(state.port, &current);
                let ips: Vec<Value> = current
                    .iter()
                    .map(|i| Value::Str(format!("{} ({})", i.ip, i.kind.label())))
                    .collect();
                state
                    .logger
                    .info("network.change", vec![("interfaces".into(), Value::Array(ips))]);
                previous = current;
            }
        }
    });
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
