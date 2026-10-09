//! The console screen: a big coloured ANSI banner with the app name, then the
//! host addresses and the access PIN, plus elevation and firewall status.
//!
//! Everything printed here is English and uses virtual-terminal escapes, which
//! `win::console::enable_ansi` turned on. The block-letter title is rendered
//! from a tiny built-in font so no external figlet is needed.

use crate::win::net::Interface;

const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[90m";

// A red gradient (256-colour) applied per banner row, echoing the red horned
// handheld icon.
const RED_ROWS: [&str; 5] = [
    "\x1b[38;5;203m",
    "\x1b[38;5;197m",
    "\x1b[38;5;196m",
    "\x1b[38;5;160m",
    "\x1b[38;5;124m",
];

/// 5-row block glyphs for the letters in "ALLYSWALLY".
fn glyph(c: char) -> [&'static str; 5] {
    match c {
        'A' => [" ███ ", "█   █", "█████", "█   █", "█   █"],
        'L' => ["█    ", "█    ", "█    ", "█    ", "█████"],
        'Y' => ["█   █", " █ █ ", "  █  ", "  █  ", "  █  "],
        'S' => [" ████", "█    ", " ███ ", "    █", "████ "],
        'W' => ["█    █", "█    █", "█ ██ █", "██  ██", "█    █"],
        _ => ["     ", "     ", "     ", "     ", "     "],
    }
}

/// Render the title as five coloured rows.
fn render_title() -> String {
    let word = "ALLYSWALLY";
    let mut rows = [String::new(), String::new(), String::new(), String::new(), String::new()];
    for ch in word.chars() {
        let g = glyph(ch);
        for (r, row) in rows.iter_mut().enumerate() {
            row.push_str(g[r]);
            row.push(' ');
        }
    }
    let mut out = String::new();
    for (r, row) in rows.iter().enumerate() {
        out.push_str("  ");
        out.push_str(RED_ROWS[r]);
        out.push_str(row);
        out.push_str(RESET);
        out.push('\n');
    }
    out
}

/// Print the full startup screen.
pub fn print_banner(
    pin: &str,
    port: u16,
    interfaces: &[Interface],
    elevated: bool,
    firewall_ready: bool,
    firewall_manual_cmd: &str,
    version: &str,
) {
    // Clear the screen and home the cursor for a clean start.
    print!("\x1b[2J\x1b[H");
    print!("{}", render_title());
    println!(
        "  {DIM}handheld assistant · v{version}{RESET}"
    );
    println!();
    print_addresses(port, interfaces);
    println!();
    println!("  {BOLD}Access PIN:{RESET}  \x1b[38;5;46m{BOLD}{pin}{RESET}");
    println!("  {DIM}Enter this PIN on the connecting device. 3 wrong tries lock that device until restart.{RESET}");
    println!();
    print_status(elevated, firewall_ready, firewall_manual_cmd, port);
    println!();
    println!("  {DIM}Live activity:{RESET}");
}

/// Print the reachable addresses, grouped by interface type.
pub fn print_addresses(port: u16, interfaces: &[Interface]) {
    if interfaces.is_empty() {
        println!("  {BOLD}No active network addresses found yet.{RESET}");
        println!("  {DIM}Connect Wi-Fi, a phone hotspot, Bluetooth PAN or USB tethering; this refreshes automatically.{RESET}");
        return;
    }
    println!("  {BOLD}Open in a browser on your phone or tablet:{RESET}");
    for iface in interfaces {
        println!(
            "    \x1b[38;5;39mhttp://{}:{}{RESET}   {DIM}{} — {}{RESET}",
            iface.ip,
            port,
            iface.kind.label(),
            iface.friendly_name
        );
    }
}

fn print_status(elevated: bool, firewall_ready: bool, firewall_manual_cmd: &str, _port: u16) {
    if elevated {
        println!("  \x1b[38;5;46m●{RESET} Running elevated (administrator) — full input injection available.");
    } else {
        println!("  \x1b[38;5;214m●{RESET} {BOLD}Not elevated.{RESET} Input to admin windows (Task Manager, apps run as admin) is blocked by Windows.");
        println!("  {DIM}  The UAC prompt (secure desktop) is never reachable. Restart as administrator for full control.{RESET}");
    }
    if firewall_ready {
        println!("  \x1b[38;5;46m●{RESET} Firewall rule in place (Private + Public).");
    } else if elevated {
        println!("  \x1b[38;5;214m●{RESET} Could not confirm the firewall rule. Connections on Public networks may be blocked.");
    } else {
        println!("  \x1b[38;5;214m●{RESET} {BOLD}Firewall rule not set{RESET} (needs elevation). Run this once as administrator:");
        println!("  {DIM}  {firewall_manual_cmd}{RESET}");
    }
}

/// Print a new PIN after regeneration.
pub fn print_pin_change(pin: &str) {
    println!();
    println!(
        "  {BOLD}PIN regenerated:{RESET}  \x1b[38;5;46m{BOLD}{pin}{RESET}   {DIM}(all sessions were invalidated){RESET}"
    );
    println!();
}

/// Print a notice that the reachable addresses changed.
pub fn print_address_change(port: u16, interfaces: &[Interface]) {
    println!();
    println!("  {DIM}Network addresses changed:{RESET}");
    print_addresses(port, interfaces);
    println!();
}
