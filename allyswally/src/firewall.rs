//! Windows Firewall inbound rule management via `netsh`.
//!
//! Bluetooth PAN and USB-tether networks are usually classified Public or
//! "unidentified", where the default firewall blocks inbound connections. When
//! the process is elevated we create an inbound allow rule for the port valid
//! on both the Private and Public profiles so the phone can reach the server on
//! any of those links. Without elevation we cannot change the firewall; the
//! console prints the exact command to run instead.

use crate::exec;
use std::time::Duration;

const RULE_NAME: &str = "AllySwally";

/// The exact command the user can run by hand when the app is not elevated.
pub fn manual_command(port: u16) -> String {
    format!(
        "netsh advfirewall firewall add rule name=\"{RULE_NAME}\" dir=in action=allow \
protocol=TCP localport={port} profile=private,public"
    )
}

/// Create (or refresh) the inbound rule. Returns true on success. Safe to call
/// repeatedly: it deletes any prior rule of the same name first so the port
/// stays in sync if it changed between runs.
pub fn ensure_rule(port: u16) -> bool {
    // Delete any existing rule with our name (ignore failure: may not exist).
    let _ = exec::run_capture(
        "netsh",
        &[
            "advfirewall".into(),
            "firewall".into(),
            "delete".into(),
            "rule".into(),
            format!("name={RULE_NAME}"),
        ],
        Duration::from_secs(10),
        16384,
    );
    let result = exec::run_capture(
        "netsh",
        &[
            "advfirewall".into(),
            "firewall".into(),
            "add".into(),
            "rule".into(),
            format!("name={RULE_NAME}"),
            "dir=in".into(),
            "action=allow".into(),
            "protocol=TCP".into(),
            format!("localport={port}"),
            "profile=private,public".into(),
        ],
        Duration::from_secs(10),
        16384,
    );
    result.launched && result.exit_code == Some(0)
}

/// Whether an inbound rule of our name currently exists.
pub fn rule_exists() -> bool {
    let result = exec::run_capture(
        "netsh",
        &[
            "advfirewall".into(),
            "firewall".into(),
            "show".into(),
            "rule".into(),
            format!("name={RULE_NAME}"),
        ],
        Duration::from_secs(10),
        16384,
    );
    result.launched && result.exit_code == Some(0) && result.stdout.contains(RULE_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_command_mentions_port_and_profiles() {
        let cmd = manual_command(8787);
        assert!(cmd.contains("localport=8787"));
        assert!(cmd.contains("profile=private,public"));
        assert!(cmd.contains("AllySwally"));
    }
}
