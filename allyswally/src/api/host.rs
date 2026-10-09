//! Host information, the shortcut band, and the bootstrap snapshot the client
//! loads on entry.

use crate::firewall;
use crate::json::{Obj, Value};
use crate::state::{AppState, CATEGORIES};
use crate::win::{net, power, sysinfo};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// The live sessions as a client list: IP, how long connected, user agent, and
/// whether each is the requester ("this device"). Tokens are never exposed.
fn connected_clients(state: &Arc<AppState>, current_token: Option<&str>) -> Value {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let clients: Vec<Value> = state
        .auth
        .sessions()
        .into_iter()
        .map(|s| {
            Obj::new()
                .str("ip", s.ip.to_string())
                .num("connectedSecs", now.saturating_sub(s.created_unix) as f64)
                .str("userAgent", s.user_agent)
                .boolean("thisDevice", current_token == Some(s.token.as_str()))
                .build()
        })
        .collect();
    Value::Array(clients)
}

/// Battery, uptime, identity and firewall status — the Host section of Settings.
pub fn host_info(state: &Arc<AppState>, current_token: Option<&str>) -> Value {
    let battery = match power::power_status() {
        Some(s) => {
            let present = s.battery_flag != 128 && s.battery_flag != 255;
            Obj::new()
                .boolean("present", present)
                .set(
                    "percent",
                    if s.percent <= 100 {
                        Value::Num(s.percent as f64)
                    } else {
                        Value::Null
                    },
                )
                .boolean("charging", s.ac_line == 1)
                .set(
                    "secondsLeft",
                    if s.seconds_left == u32::MAX {
                        Value::Null
                    } else {
                        Value::Num(s.seconds_left as f64)
                    },
                )
                .boolean("onAc", s.ac_line == 1)
                .build()
        }
        None => Obj::new().boolean("present", false).build(),
    };

    let interfaces: Vec<Value> = net::interfaces()
        .into_iter()
        .map(|i| {
            Obj::new()
                .str("ip", i.ip.to_string())
                .str("name", i.friendly_name)
                .str("kind", i.kind.label())
                .build()
        })
        .collect();

    Obj::new()
        .str("computerName", sysinfo::computer_name())
        .str("windows", sysinfo::windows_label())
        .boolean("elevated", state.elevated)
        .set(
            "firewall",
            Obj::new()
                .boolean("ready", state.firewall_ready.load(Ordering::Relaxed))
                .str("manualCommand", firewall::manual_command(state.port))
                .build(),
        )
        .num("hostUptimeSecs", state.host_uptime_secs() as f64)
        .num("serverUptimeSecs", state.server_uptime_secs() as f64)
        .num("port", state.port as f64)
        .set("battery", battery)
        .set("interfaces", Value::Array(interfaces))
        .set("clients", connected_clients(state, current_token))
        .build()
}

/// The shortcut band: every item flagged `showInBand`, across the three
/// user-facing categories (shortcuts, launchers, clipboard — scripts are
/// included too since they are runnable), annotated with its category and
/// sorted by `order`.
pub fn band_items(state: &Arc<AppState>) -> Value {
    let mut out: Vec<Value> = Vec::new();
    for category in CATEGORIES {
        let list = state.store.get(&AppState::category_file(category));
        if let Some(items) = list.as_array() {
            for it in items {
                if it.get_bool("showInBand") == Some(true) {
                    let mut pairs = it.as_object().unwrap_or(&[]).to_vec();
                    pairs.push(("category".to_string(), Value::Str((*category).to_string())));
                    out.push(Value::Object(pairs));
                }
            }
        }
    }
    out.sort_by_key(|it| it.get_i64("order").unwrap_or(0));
    Value::Array(out)
}

/// Everything the client needs on entry: version, elevation, firewall, host
/// info, all categories, the band, the config and any JSON diagnostics.
pub fn bootstrap(state: &Arc<AppState>, current_token: Option<&str>) -> Value {
    let mut categories = Obj::new();
    for category in CATEGORIES {
        categories = categories.set(category, state.store.get(&AppState::category_file(category)));
    }

    let errors: Vec<Value> = state
        .store
        .errors()
        .into_iter()
        .map(|e| {
            Obj::new()
                .str("file", e.file)
                .str("message", e.message)
                .num("line", e.line as f64)
                .num("column", e.column as f64)
                .build()
        })
        .collect();

    Obj::new()
        .str("version", state.version)
        .str("buildDate", state.build_date)
        .boolean("elevated", state.elevated)
        .boolean("devNoAuth", state.dev_no_auth)
        .set("host", host_info(state, current_token))
        .set("categories", categories.build())
        .set("band", band_items(state))
        .set("config", state.config_value())
        .set("diagnostics", Obj::new().set("jsonErrors", Value::Array(errors)).build())
        .build()
}
