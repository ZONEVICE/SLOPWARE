//! Command-line arguments and the host `config.json`.
//!
//! The CLI is tiny: an optional port (default 8787; a busy port walks upward),
//! `firewall-setup` (fix this executable's firewall rules and exit — what the
//! elevated helper runs, see [`crate::firewall`]) and a debug-only
//! `--dev-no-auth` flag used by the screenshot harness. The
//! host config is a JSON object stored in `user-data\config.json`, editable by
//! hand and hot-reloaded through the [`crate::store::Store`]; this module only
//! builds the defaults (with interpreter autodetection) and offers typed views
//! over whatever the store currently holds.

use crate::json::{Obj, Value};
use std::path::{Path, PathBuf};

/// Default TCP port. Fixed so the user can bookmark it; overridable on the CLI.
pub const DEFAULT_PORT: u16 = 8787;

pub struct CliArgs {
    pub port: u16,
    /// Fix the firewall rules for this executable and exit (needs elevation).
    pub firewall_setup: bool,
    /// Debug-only: skip the PIN gate so the screenshot harness can reach every
    /// screen. Compiled out of release builds (see `main`).
    pub dev_no_auth: bool,
}

impl CliArgs {
    /// Parse `std::env::args`. Accepts both bare words (`port 9000`, matching
    /// the other apps in this repository) and dashed spellings (`--port 9000`).
    pub fn parse() -> Result<CliArgs, String> {
        let args: Vec<String> = std::env::args().skip(1).collect();
        Self::parse_from(&args)
    }

    pub fn parse_from(args: &[String]) -> Result<CliArgs, String> {
        let mut port = DEFAULT_PORT;
        let mut firewall_setup = false;
        let mut dev_no_auth = false;
        let mut i = 0;
        while i < args.len() {
            let arg = args[i].trim_start_matches('-');
            match arg {
                "port" => {
                    i += 1;
                    let value = args
                        .get(i)
                        .ok_or_else(|| "`port` needs a number, e.g. `port 8787`".to_string())?;
                    port = value
                        .parse::<u16>()
                        .map_err(|_| format!("invalid port `{value}`"))?;
                }
                "firewall-setup" => firewall_setup = true,
                // The screenshot/no-auth flag exists only in debug builds; in
                // release it is an unknown argument, so the PIN gate can never
                // be bypassed in a shipped binary.
                "dev-no-auth" if cfg!(debug_assertions) => dev_no_auth = true,
                "help" | "h" => return Err(HELP.to_string()),
                other if other.starts_with("port=") => {
                    let value = &other["port=".len()..];
                    port = value
                        .parse::<u16>()
                        .map_err(|_| format!("invalid port `{value}`"))?;
                }
                other => return Err(format!("unknown argument `{other}`. {HELP}")),
            }
            i += 1;
        }
        Ok(CliArgs {
            port,
            firewall_setup,
            dev_no_auth,
        })
    }
}

const HELP: &str =
    "Usage: AllySwally [port <number>] [firewall-setup] [--dev-no-auth (debug builds only)]";

/// Build the default `config.json`, autodetecting interpreter paths so the
/// MASKED "run code" feature works out of the box where possible.
pub fn default_config() -> Value {
    let interp = detect_interpreters();
    Obj::new()
        .num("version", 1)
        .num("logRetentionDays", 14)
        .num("commandTimeoutSecs", 20)
        .num("commandOutputLimitBytes", 65536)
        .set(
            "interpreters",
            Obj::new()
                .str("python", interp.python.unwrap_or_default())
                .str("node", interp.node.unwrap_or_default())
                .str("ahkV1", interp.ahk_v1.unwrap_or_default())
                .str("ahkV2", interp.ahk_v2.unwrap_or_default())
                .build(),
        )
        .boolean("firewallAutoRule", true)
        .set(
            "defaults",
            Obj::new().str("theme", "dark").boolean("showBand", true).build(),
        )
        .build()
}

/// Typed, defaulted views over the live config `Value`.
pub struct HostConfig<'a> {
    pub raw: &'a Value,
}

impl<'a> HostConfig<'a> {
    pub fn new(raw: &'a Value) -> HostConfig<'a> {
        HostConfig { raw }
    }

    pub fn log_retention_days(&self) -> u64 {
        self.raw.get_i64("logRetentionDays").filter(|&n| n >= 0).unwrap_or(14) as u64
    }

    pub fn command_timeout_secs(&self) -> u64 {
        self.raw.get_i64("commandTimeoutSecs").filter(|&n| n > 0).unwrap_or(20) as u64
    }

    pub fn command_output_limit(&self) -> usize {
        self.raw
            .get_i64("commandOutputLimitBytes")
            .filter(|&n| n > 0)
            .unwrap_or(65536) as usize
    }

    pub fn firewall_auto_rule(&self) -> bool {
        self.raw.get_bool("firewallAutoRule").unwrap_or(true)
    }

    /// Resolve the interpreter path for a language key (`python`, `node`,
    /// `ahkV1`, `ahkV2`), if configured and non-empty.
    pub fn interpreter(&self, key: &str) -> Option<String> {
        self.raw
            .get("interpreters")
            .and_then(|i| i.get_str(key))
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    }
}

// --- Interpreter autodetection ---------------------------------------------

#[derive(Default)]
pub struct Interpreters {
    pub python: Option<String>,
    pub node: Option<String>,
    pub ahk_v1: Option<String>,
    pub ahk_v2: Option<String>,
}

/// Best-effort autodetection: the `py` launcher or `python.exe`/`node.exe` on
/// `PATH`, and the usual AutoHotkey v1/v2 install locations.
pub fn detect_interpreters() -> Interpreters {
    Interpreters {
        python: which("py.exe").or_else(|| which("python.exe")),
        node: which("node.exe"),
        ahk_v1: first_existing(&[
            r"C:\Program Files\AutoHotkey\AutoHotkeyU64.exe",
            r"C:\Program Files\AutoHotkey\AutoHotkey.exe",
            r"C:\Program Files\AutoHotkey\v1.1\AutoHotkeyU64.exe",
        ]),
        ahk_v2: first_existing(&[
            r"C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe",
            r"C:\Program Files\AutoHotkey\v2\AutoHotkey32.exe",
            r"C:\Program Files\AutoHotkey\AutoHotkey64.exe",
        ]),
    }
}

/// Resolve an executable name against `PATH` without spawning a process.
fn which(exe: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

fn first_existing(candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .find(|p| Path::new(p).is_file())
        .map(|p| p.to_string())
}

/// The named mutex used for the single-instance guard.
pub const INSTANCE_MUTEX: &str = "Global\\AllySwallySingleInstance";

/// The data directory path for display, resolved the same way as [`crate::paths`].
pub fn data_dir_display() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".allyswally")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_port_when_no_args() {
        let args = CliArgs::parse_from(&[]).unwrap();
        assert_eq!(args.port, DEFAULT_PORT);
        assert!(!args.firewall_setup);
        assert!(!args.dev_no_auth);
    }

    #[test]
    fn firewall_setup_flag() {
        let bare = CliArgs::parse_from(&[crate::firewall::SETUP_ARG.into()]).unwrap();
        assert!(bare.firewall_setup);
        assert!(CliArgs::parse_from(&["--firewall-setup".into()]).unwrap().firewall_setup);
    }

    #[test]
    fn bare_and_dashed_port() {
        assert_eq!(
            CliArgs::parse_from(&["port".into(), "9000".into()]).unwrap().port,
            9000
        );
        assert_eq!(
            CliArgs::parse_from(&["--port".into(), "9100".into()]).unwrap().port,
            9100
        );
        assert_eq!(
            CliArgs::parse_from(&["--port=9200".into()]).unwrap().port,
            9200
        );
    }

    #[test]
    fn dev_flag() {
        assert!(CliArgs::parse_from(&["--dev-no-auth".into()]).unwrap().dev_no_auth);
    }

    #[test]
    fn rejects_unknown_and_bad_port() {
        assert!(CliArgs::parse_from(&["--wat".into()]).is_err());
        assert!(CliArgs::parse_from(&["port".into(), "notnum".into()]).is_err());
        assert!(CliArgs::parse_from(&["port".into()]).is_err());
    }

    #[test]
    fn host_config_defaults_are_sane() {
        let cfg = default_config();
        let view = HostConfig::new(&cfg);
        assert_eq!(view.log_retention_days(), 14);
        assert_eq!(view.command_timeout_secs(), 20);
        assert!(view.firewall_auto_rule());
    }
}
