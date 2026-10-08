//! Configuration: command-line flags, environment variables and defaults.
//!
//! Precedence (highest first): explicit overrides (tests) -> CLI flag ->
//! environment variable -> default. The flags and variables are the Node.js
//! implementation's, so both start the same way:
//!
//!   reptile                     -> HTTP on port 55667 (or the next free one)
//!   reptile --http              -> the same, explicitly
//!   reptile --https             -> a fresh self-signed certificate, then HTTPS
//!   reptile --port 8080         -> start at 8080, walking up if it is busy

use crate::domain::discovery::DiscoverySettings;
use crate::domain::identity::{system_interfaces, InterfaceSource};
use crate::domain::protocol::Timing;
use crate::fs::watcher::WatcherTiming;
use crate::util::logger::Level;
use crate::util::net::{parse_host_spec, parse_port_spec};
use crate::util::sys::data_dir;
use std::path::PathBuf;

/// Default port. Discovery scans it and the ports that follow it.
pub const DEFAULT_PORT: u16 = 55667;

/// How many ports, starting at the default, discovery scans on each host.
pub const SCAN_PORT_COUNT: u16 = 20;

pub fn usage() -> String {
    let end = DEFAULT_PORT + SCAN_PORT_COUNT - 1;
    format!(
        "reptile - real-time two-way directory sync between two computers on a LAN

Usage:
  reptile                         HTTP, starting at port {DEFAULT_PORT}
  reptile --http                  The same, explicitly
  reptile --https                 Generate a new self-signed certificate, then HTTPS
  reptile --port 8080             Start at another port (the next free one is used if busy)

Options:
  --http                  Serve plain HTTP (default)
  --https                 Serve HTTPS with a certificate generated at startup
  -p, --port <number>     First port to try (default: {DEFAULT_PORT})
  -H, --host <address>    Interface to bind (default: 0.0.0.0, every interface)
  --no-scan               Start with the background network scan switched off
  --scan-hosts <list>     Scan these hosts instead of the local subnets,
                          e.g. 192.168.1.0/24,10.0.0.7
  --scan-ports <list>     Scan these ports instead of {DEFAULT_PORT}-{end},
                          e.g. 55667-55686,8080
  --remote-ui             Let other computers open this instance's control panel
  --log-level <level>     silent | error | warn | info | debug (default: info)
  -v, --version           Print the version
  -h, --help              Show this message

Environment:
  REPTILE_PORT, REPTILE_HOST, REPTILE_PROTOCOL, REPTILE_LOG_LEVEL,
  REPTILE_PORT_ATTEMPTS, REPTILE_SCAN (0 disables), REPTILE_SCAN_HOSTS,
  REPTILE_SCAN_PORTS, REPTILE_REMOTE_UI (1 enables), REPTILE_CERT_DIR,
  REPTILE_PUBLIC_DIR (serve the control panel from a directory)"
    )
}

#[derive(Default, Debug)]
pub struct Args {
    pub protocol: Option<&'static str>,
    pub port: Option<u16>,
    pub host: Option<String>,
    pub scan: Option<bool>,
    pub scan_hosts: Option<String>,
    pub scan_ports: Option<String>,
    pub remote_ui: bool,
    pub log_level: Option<String>,
    pub help: bool,
    pub version: bool,
    pub unknown: Vec<String>,
}

/// Parse `--flag`, `--key value` and `--key=value`. Unknown flags are
/// collected so the caller can warn instead of failing silently.
pub fn parse_args(argv: &[String]) -> Args {
    let mut out = Args::default();
    let mut index = 0;
    while index < argv.len() {
        let raw = &argv[index];
        let (flag, inline) = match raw.split_once('=') {
            Some((flag, value)) => (flag, Some(value.to_string())),
            None => (raw.as_str(), None),
        };
        let mut value = || -> Option<String> {
            if inline.is_some() {
                return inline.clone();
            }
            index += 1;
            argv.get(index).cloned()
        };
        match flag {
            "--http" => out.protocol = Some("http"),
            "--https" => out.protocol = Some("https"),
            "-p" | "--port" => out.port = value().and_then(|v| v.trim().parse::<u16>().ok()),
            "-H" | "--host" => out.host = value(),
            "--no-scan" => out.scan = Some(false),
            "--scan-hosts" => out.scan_hosts = value(),
            "--scan-ports" => out.scan_ports = value(),
            "--remote-ui" => out.remote_ui = true,
            "--log-level" => out.log_level = value(),
            "-h" | "--help" => out.help = true,
            "-v" | "--version" => out.version = true,
            _ => {
                if raw.starts_with('-') {
                    out.unknown.push(raw.clone());
                }
            }
        }
        index += 1;
    }
    out
}

pub struct Config {
    pub protocol: &'static str,
    pub host: String,
    pub port: u16,
    /// How many consecutive ports to try; 1 turns a busy port into an error.
    pub port_attempts: u32,
    pub help: bool,
    pub version: bool,
    pub unknown_args: Vec<String>,
    pub log_level: Level,
    /// Serve the control panel from here instead of the embedded copy.
    pub public_dir: Option<PathBuf>,
    /// Replaced on every --https start.
    pub cert_dir: PathBuf,
    /// The control panel answers only this machine unless this is true.
    pub allow_remote_ui: bool,
    pub interfaces: InterfaceSource,
    pub discovery: DiscoverySettings,
    pub timing: Timing,
    pub watcher: WatcherTiming,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

impl Config {
    /// The effective configuration for these arguments and the environment.
    pub fn from_args(argv: &[String]) -> Config {
        let args = parse_args(argv);
        let protocol = args.protocol.unwrap_or_else(|| {
            if env("REPTILE_PROTOCOL").map(|p| p.eq_ignore_ascii_case("https")).unwrap_or(false) {
                "https"
            } else {
                "http"
            }
        });
        let port = args
            .port
            .or_else(|| env("REPTILE_PORT").and_then(|p| p.trim().parse::<u16>().ok()))
            .unwrap_or(DEFAULT_PORT);

        // Discovery scans the default port range; an instance started
        // elsewhere (--port 8080) also scans its own neighbourhood, so two
        // instances started with the same custom port still find each other.
        let range =
            |start: u16| (0..SCAN_PORT_COUNT).filter_map(move |offset| start.checked_add(offset)).collect::<Vec<u16>>();
        let scan_port_spec = args.scan_ports.clone().or_else(|| env("REPTILE_SCAN_PORTS"));
        let mut ports = match &scan_port_spec {
            Some(spec) => parse_port_spec(spec),
            None => range(DEFAULT_PORT),
        };
        if scan_port_spec.is_none() && port > 0 && !ports.contains(&port) {
            ports.extend(range(port));
        }
        let hosts = args.scan_hosts.clone().or_else(|| env("REPTILE_SCAN_HOSTS")).map(|spec| parse_host_spec(&spec));

        Config {
            protocol,
            host: args.host.clone().or_else(|| env("REPTILE_HOST")).unwrap_or_else(|| "0.0.0.0".into()),
            port,
            port_attempts: env("REPTILE_PORT_ATTEMPTS").and_then(|v| v.trim().parse().ok()).unwrap_or(64),
            help: args.help,
            version: args.version,
            unknown_args: args.unknown.clone(),
            log_level: Level::parse(
                &args.log_level.clone().or_else(|| env("REPTILE_LOG_LEVEL")).unwrap_or_else(|| "info".into()),
            ),
            public_dir: env("REPTILE_PUBLIC_DIR").map(PathBuf::from),
            cert_dir: env("REPTILE_CERT_DIR").map(PathBuf::from).unwrap_or_else(|| data_dir().join("cert")),
            allow_remote_ui: args.remote_ui || env("REPTILE_REMOTE_UI").as_deref() == Some("1"),
            interfaces: system_interfaces(),
            discovery: DiscoverySettings {
                enabled: args.scan.unwrap_or_else(|| env("REPTILE_SCAN").as_deref() != Some("0")),
                hosts,
                ports,
                concurrency: 128,
                connect_timeout_ms: 700,
                request_timeout_ms: 2000,
                sweep_interval_ms: 8000,
                refresh_interval_ms: 3000,
                stale_ms: 12_000,
                alive_memory_ms: 5 * 60_000,
            },
            timing: Timing::default(),
            watcher: WatcherTiming::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn flags() {
        let parsed = parse_args(&args(&["--https", "--port=8080", "-H", "127.0.0.1", "--no-scan", "--bogus"]));
        assert_eq!(parsed.protocol, Some("https"));
        assert_eq!(parsed.port, Some(8080));
        assert_eq!(parsed.host.as_deref(), Some("127.0.0.1"));
        assert_eq!(parsed.scan, Some(false));
        assert_eq!(parsed.unknown, vec!["--bogus"]);
        let config = Config::from_args(&args(&["--port", "8080", "--scan-hosts", "10.0.0.7"]));
        assert_eq!(config.port, 8080);
        assert!(config.discovery.ports.contains(&55667) && config.discovery.ports.contains(&8080));
        assert_eq!(config.discovery.hosts, Some(vec!["10.0.0.7".to_string()]));
    }
}
