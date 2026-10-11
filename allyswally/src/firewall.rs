//! Windows Firewall: make sure this executable may accept inbound connections.
//!
//! The trap this module exists for: the first time a program listens on the
//! network without a matching rule, Windows shows its "allow access" prompt and
//! stores the answer as *per-program* rules — typically Allow on Private and
//! **Block on Public**. A Block rule beats every Allow rule (a port rule
//! included), so on a network classified Public — home Wi-Fi often is,
//! Bluetooth PAN and USB tethering usually are — the phone can never connect.
//! The rules are bound to the full path of the `.exe`, so a copy moved to
//! another folder starts from scratch.
//!
//! At startup, before the port is bound (listening is what raises that prompt),
//! [`ensure`] reads the rules for this exact path from the local rule store in
//! the registry — milliseconds, and allowed for standard users. If any rule
//! blocks it, or none allows it on both Private and Public, every inbound rule
//! for the path is replaced by one Allow rule on all profiles. Changing the
//! firewall needs administrator rights: an elevated process does it in place;
//! otherwise AllySwally relaunches itself elevated with [`SETUP_ARG`] (one UAC
//! prompt), waits, and re-reads the store to confirm. The change runs through
//! PowerShell's NetSecurity cmdlets, which can delete a rule by its unique ID;
//! `netsh` can only match rules by display name.

use crate::base64;
use crate::exec;
use crate::win::registry;
use crate::win::shell::{self, Elevated};
use std::time::Duration;

/// Display name of the rule AllySwally creates (`firewall-add-rules.bat` uses it too).
pub const RULE_NAME: &str = "AllySwally (program)";

/// The command-line argument of the elevated helper run.
pub const SETUP_ARG: &str = "firewall-setup";

/// The local (persistent) rule store: one `REG_SZ` value per rule, named by
/// the rule's unique ID, data like
/// `v2.30|Action=Block|Active=TRUE|Dir=In|Protocol=6|Profile=Public|App=C:\…\x.exe|Name=…|`.
const RULES_KEY: &str =
    r"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules";

const PROFILE_DOMAIN: u8 = 1;
const PROFILE_PRIVATE: u8 = 2;
const PROFILE_PUBLIC: u8 = 4;
const PROFILE_ALL: u8 = PROFILE_DOMAIN | PROFILE_PRIVATE | PROFILE_PUBLIC;

/// How long to wait for the elevated helper once the UAC prompt is accepted.
const HELPER_TIMEOUT_MS: u32 = 120_000;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    Allow,
    Block,
    Other,
}

/// The fields of one stored rule that matter here.
#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    pub id: String,
    pub action: Action,
    pub enabled: bool,
    pub inbound: bool,
    /// The rule applies to TCP (no `Protocol=` field, or protocol 6).
    pub tcp: bool,
    /// `PROFILE_*` bitmask; a rule without a `Profile=` field applies to all.
    pub profiles: u8,
    pub app: Option<String>,
}

/// What is wrong with the rules for this executable.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Problem {
    /// An enabled Block rule (usually left by Windows' own prompt).
    Blocked,
    /// No enabled Allow rule covers both Private and Public networks.
    NotAllowed,
}

impl Problem {
    pub fn describe(self) -> &'static str {
        match self {
            Problem::Blocked => "a Block rule stops AllySwally.exe on some networks",
            Problem::NotAllowed => "no rule allows AllySwally.exe on Private and Public networks",
        }
    }
}

/// The result of the startup check.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// Already allowed; nothing changed.
    Ready,
    /// Fixed during this start; `blocks` Block rules were removed.
    Repaired { blocks: usize },
    /// The user answered "No" on the UAC prompt.
    Declined(Problem),
    /// The fix could not run, or the rules are still wrong after it.
    Failed(Problem, String),
    /// The rule store could not be read.
    Unknown(String),
    /// The check did not run (the reason is shown as-is).
    Skipped(&'static str),
}

impl Outcome {
    pub fn is_ready(&self) -> bool {
        matches!(self, Outcome::Ready | Outcome::Repaired { .. })
    }

    /// Short machine-friendly status for the log.
    pub fn label(&self) -> &'static str {
        match self {
            Outcome::Ready => "ready",
            Outcome::Repaired { .. } => "repaired",
            Outcome::Declined(_) => "declined",
            Outcome::Failed(..) => "failed",
            Outcome::Unknown(_) => "unknown",
            Outcome::Skipped(_) => "skipped",
        }
    }

    /// Human detail for the log, if any.
    pub fn detail(&self) -> Option<String> {
        match self {
            Outcome::Ready => None,
            Outcome::Repaired { blocks } => Some(format!("removed {blocks} block rule(s)")),
            Outcome::Declined(problem) => Some(problem.describe().to_string()),
            Outcome::Failed(problem, reason) => Some(format!("{}; {reason}", problem.describe())),
            Outcome::Unknown(reason) => Some(reason.clone()),
            Outcome::Skipped(reason) => Some(reason.to_string()),
        }
    }
}

/// The startup check-and-fix. `before_fix` runs once a problem is found, just
/// before the fix starts (and, when not elevated, before the UAC prompt), so
/// the console can say what is about to happen.
pub fn ensure(exe: &str, elevated: bool, before_fix: impl FnOnce(Problem)) -> Outcome {
    let rules = match rules_for(exe) {
        Ok(rules) => rules,
        Err(e) => return Outcome::Unknown(e),
    };
    let Some(problem) = assess(&rules) else {
        return Outcome::Ready;
    };
    let blocks = rules
        .iter()
        .filter(|r| r.enabled && r.action == Action::Block)
        .count();
    before_fix(problem);
    let result = if elevated {
        repair(exe)
    } else {
        match shell::run_elevated(exe, SETUP_ARG, HELPER_TIMEOUT_MS) {
            Elevated::Declined => return Outcome::Declined(problem),
            Elevated::Failed(code) => Err(format!(
                "could not start the elevated helper (Windows error {code})"
            )),
            Elevated::Exited(code) => {
                verify(exe).map_err(|e| format!("{e} (helper exit code {code})"))
            }
            Elevated::TimedOut => {
                verify(exe).map_err(|e| format!("{e} (the helper did not finish in time)"))
            }
        }
    };
    match result {
        Ok(()) => Outcome::Repaired { blocks },
        Err(reason) => Outcome::Failed(problem, reason),
    }
}

/// Replace every inbound rule for `exe` with a single Allow rule on all
/// profiles, then confirm from the rule store. Needs administrator rights.
pub fn repair(exe: &str) -> Result<(), String> {
    let ids: Vec<String> = rules_for(exe)?.into_iter().map(|r| r.id).collect();
    let result = run_powershell(&repair_script(exe, &ids));
    if !result.launched {
        return Err(result
            .error
            .unwrap_or_else(|| "PowerShell did not start".to_string()));
    }
    verify(exe).map_err(|e| {
        // The script reports a failure as one `ERROR: …` line on stdout.
        match result.stdout.lines().find_map(|l| l.trim().strip_prefix("ERROR: ")) {
            Some(detail) => format!("{e}: {detail}"),
            None => e,
        }
    })
}

/// Ok when the rules for `exe` are right, otherwise why not.
fn verify(exe: &str) -> Result<(), String> {
    match assess(&rules_for(exe)?) {
        None => Ok(()),
        Some(Problem::Blocked) => Err("a Block rule for AllySwally.exe is still in place".into()),
        Some(Problem::NotAllowed) => Err("no Allow rule for AllySwally.exe was added".into()),
    }
}

/// The inbound rules whose program is `exe`, read from the local rule store.
pub fn rules_for(exe: &str) -> Result<Vec<Rule>, String> {
    let values = registry::hklm_string_values(RULES_KEY)
        .map_err(|code| format!("cannot read the firewall rules (Windows error {code})"))?;
    let target = normalize_path(exe);
    Ok(values
        .iter()
        .filter_map(|(id, data)| parse_rule(id, data))
        .filter(|r| r.inbound && r.app.as_deref().map(normalize_path).as_deref() == Some(&*target))
        .collect())
}

/// Parse one rule-store value. `None` if it is not a `v2.x` rule string.
pub fn parse_rule(id: &str, data: &str) -> Option<Rule> {
    let mut fields = data.split('|');
    if !fields.next()?.starts_with('v') {
        return None;
    }
    let mut rule = Rule {
        id: id.to_string(),
        action: Action::Other,
        enabled: false,
        inbound: false,
        tcp: true,
        profiles: 0,
        app: None,
    };
    for field in fields {
        let Some((key, value)) = field.split_once('=') else {
            continue;
        };
        match key {
            "Action" => {
                rule.action = match value {
                    "Allow" => Action::Allow,
                    "Block" => Action::Block,
                    _ => Action::Other,
                }
            }
            "Active" => rule.enabled = value.eq_ignore_ascii_case("TRUE"),
            "Dir" => rule.inbound = value == "In",
            "Protocol" => rule.tcp = value == "6",
            "Profile" => {
                rule.profiles |= match value {
                    "Domain" => PROFILE_DOMAIN,
                    "Private" => PROFILE_PRIVATE,
                    "Public" => PROFILE_PUBLIC,
                    _ => 0,
                }
            }
            "App" => rule.app = Some(value.to_string()),
            _ => {}
        }
    }
    if rule.profiles == 0 {
        rule.profiles = PROFILE_ALL;
    }
    Some(rule)
}

/// `None` when the rules let TCP in on both Private and Public networks.
pub fn assess(rules: &[Rule]) -> Option<Problem> {
    let mut allowed = 0u8;
    for rule in rules.iter().filter(|r| r.enabled && r.inbound && r.tcp) {
        match rule.action {
            Action::Block => return Some(Problem::Blocked),
            Action::Allow => allowed |= rule.profiles,
            Action::Other => {}
        }
    }
    let needed = PROFILE_PRIVATE | PROFILE_PUBLIC;
    if allowed & needed == needed {
        None
    } else {
        Some(Problem::NotAllowed)
    }
}

/// This executable's full path, as the firewall sees it.
pub fn exe_path() -> String {
    let path = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "AllySwally.exe".to_string());
    strip_verbatim(&path)
}

/// Drop a `\\?\` (or `\\?\UNC\`) prefix.
fn strip_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    }
}

/// Compare-ready form of a path: environment variables expanded, verbatim
/// prefix dropped, backslashes only, lower case (Windows paths are
/// case-insensitive, and Windows' own prompt stores them lower-cased).
fn normalize_path(path: &str) -> String {
    let expanded = expand_env(path.trim().trim_matches('"'));
    strip_verbatim(&expanded).replace('/', "\\").to_lowercase()
}

/// Expand `%NAME%` references; unknown names are left as written.
fn expand_env(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let name = &after[..end];
        match std::env::var(name) {
            Ok(value) if !name.is_empty() => out.push_str(&value),
            _ => {
                out.push('%');
                out.push_str(name);
                out.push('%');
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// A PowerShell single-quoted string literal. PowerShell also ends such a
/// literal on the typographic single quotes, so those are doubled as well.
fn ps_quote(s: &str) -> String {
    let mut out = String::from("'");
    for c in s.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
        out.push(c);
    }
    out.push('\'');
    out
}

/// The elevated fix: remove the given rule IDs (exact match, no wildcards)
/// and add one Allow rule for `exe` on every profile.
fn repair_script(exe: &str, ids: &[String]) -> String {
    let id_list: Vec<String> = ids.iter().map(|id| ps_quote(id)).collect();
    format!(
        "$ErrorActionPreference = 'Stop'\n\
         $ProgressPreference = 'SilentlyContinue'\n\
         $ids = @({ids})\n\
         try {{\n\
         \x20 if ($ids.Count -gt 0) {{\n\
         \x20   Get-NetFirewallRule -PolicyStore PersistentStore | Where-Object {{ $ids -contains $_.Name }} | Remove-NetFirewallRule\n\
         \x20 }}\n\
         \x20 New-NetFirewallRule -DisplayName {name} -Description {desc} -Direction Inbound -Action Allow -Program {exe} -Profile Any | Out-Null\n\
         }} catch {{\n\
         \x20 Write-Output ('ERROR: ' + $_.Exception.Message)\n\
         \x20 exit 1\n\
         }}\n",
        ids = id_list.join(", "),
        name = ps_quote(RULE_NAME),
        desc = ps_quote("Lets phones and tablets on the network reach AllySwally. Created by AllySwally.exe."),
        exe = ps_quote(exe),
    )
}

/// Run a script with the inbox Windows PowerShell, passed as
/// `-EncodedCommand` (Base64 of UTF-16LE) so no quoting can break it.
fn run_powershell(script: &str) -> exec::ExecResult {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    exec::run_capture(
        &format!(r"{root}\System32\WindowsPowerShell\v1.0\powershell.exe"),
        &[
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-EncodedCommand".into(),
            base64::encode(&utf16),
        ],
        Duration::from_secs(90),
        65536,
    )
}

/// The same fix as a one-liner the user can paste into an administrator
/// PowerShell.
pub fn manual_command(exe: &str) -> String {
    let exe = ps_quote(exe);
    format!(
        "Get-NetFirewallApplicationFilter | Where-Object Program -eq {exe} | Get-NetFirewallRule | \
Where-Object Direction -eq Inbound | Remove-NetFirewallRule; New-NetFirewallRule -DisplayName {name} \
-Direction Inbound -Action Allow -Program {exe} -Profile Any",
        name = ps_quote(RULE_NAME),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Values as Windows stores them (taken from a real machine).
    const PROMPT_ALLOW: &str = r"v2.10|Action=Allow|Active=TRUE|Dir=In|Protocol=6|Profile=Private|App=C:\users\vice\desktop\allyswally.exe|Name=allyswally.exe|Desc=allyswally.exe|Defer=User|";
    const PROMPT_BLOCK: &str = r"v2.30|Action=Block|Active=TRUE|Dir=In|Protocol=6|Profile=Public|App=C:\users\vice\desktop\allyswally.exe|Name=allyswally.exe|Desc=allyswally.exe|";
    const PORT_RULE: &str = r"v2.30|Action=Allow|Active=TRUE|Dir=In|Protocol=6|Profile=Private|Profile=Public|LPort=8787|Name=AllySwally|";

    fn rule(data: &str) -> Rule {
        parse_rule("id", data).unwrap()
    }

    #[test]
    fn parses_prompt_rules() {
        let allow = rule(PROMPT_ALLOW);
        assert_eq!(allow.action, Action::Allow);
        assert!(allow.enabled && allow.inbound && allow.tcp);
        assert_eq!(allow.profiles, PROFILE_PRIVATE);
        assert_eq!(allow.app.as_deref(), Some(r"C:\users\vice\desktop\allyswally.exe"));

        let block = rule(PROMPT_BLOCK);
        assert_eq!(block.action, Action::Block);
        assert_eq!(block.profiles, PROFILE_PUBLIC);
    }

    #[test]
    fn parses_profiles_protocols_and_direction() {
        let port = rule(PORT_RULE);
        assert_eq!(port.profiles, PROFILE_PRIVATE | PROFILE_PUBLIC);
        assert!(port.app.is_none());
        // No Profile= field means every profile; no Protocol= means any.
        let any = rule(r"v2.30|Action=Allow|Active=TRUE|Dir=In|App=C:\x.exe|");
        assert_eq!(any.profiles, PROFILE_ALL);
        assert!(any.tcp);
        let udp_out = rule(r"v2.30|Action=Allow|Active=FALSE|Dir=Out|Protocol=17|App=C:\x.exe|");
        assert!(!udp_out.tcp && !udp_out.inbound && !udp_out.enabled);
        assert!(parse_rule("id", "garbage").is_none());
    }

    #[test]
    fn a_block_rule_wins() {
        let rules = [rule(PROMPT_ALLOW), rule(PROMPT_BLOCK)];
        assert_eq!(assess(&rules), Some(Problem::Blocked));
    }

    #[test]
    fn private_only_is_not_enough() {
        assert_eq!(assess(&[rule(PROMPT_ALLOW)]), Some(Problem::NotAllowed));
        assert_eq!(assess(&[]), Some(Problem::NotAllowed));
    }

    #[test]
    fn ready_when_allowed_everywhere() {
        let ours = rule(r"v2.30|Action=Allow|Active=TRUE|Dir=In|App=C:\x.exe|Name=AllySwally (program)|");
        assert_eq!(assess(&[ours.clone()]), None);
        // A disabled block and a UDP-only block do not count against it.
        let disabled = rule(&PROMPT_BLOCK.replace("Active=TRUE", "Active=FALSE"));
        let udp = rule(&PROMPT_BLOCK.replace("Protocol=6", "Protocol=17"));
        assert_eq!(assess(&[ours, disabled, udp]), None);
    }

    #[test]
    fn udp_allow_does_not_cover_tcp() {
        let udp = rule(r"v2.30|Action=Allow|Active=TRUE|Dir=In|Protocol=17|App=C:\x.exe|");
        assert_eq!(assess(&[udp]), Some(Problem::NotAllowed));
    }

    #[test]
    fn paths_compare_case_and_prefix_insensitively() {
        assert_eq!(
            normalize_path(r"\\?\C:\Users\VICE\Desktop\AllySwally.exe"),
            normalize_path(r"C:\users\vice\desktop\allyswally.exe")
        );
        assert_eq!(normalize_path("C:/a/B.exe"), r"c:\a\b.exe");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share\a.exe"), r"\\srv\share\a.exe");
    }

    #[test]
    fn expands_environment_variables() {
        let root = std::env::var("SystemRoot").unwrap();
        assert_eq!(expand_env(r"%SystemRoot%\x.exe"), format!(r"{root}\x.exe"));
        assert_eq!(expand_env("%NoSuchVar_AllySwally%"), "%NoSuchVar_AllySwally%");
        assert_eq!(expand_env("100%"), "100%");
    }

    #[test]
    fn powershell_quoting() {
        assert_eq!(ps_quote(r"C:\a b\x.exe"), r"'C:\a b\x.exe'");
        assert_eq!(ps_quote("O'Brien"), "'O''Brien'");
        assert_eq!(ps_quote("O\u{2019}Brien"), "'O\u{2019}\u{2019}Brien'");
    }

    #[test]
    fn repair_script_names_the_rules_and_the_program() {
        let ids = vec!["{6060EE11}".to_string(), r"TCP Query User{E5}C:\x [1].exe".to_string()];
        let script = repair_script(r"C:\x [1].exe", &ids);
        assert!(script.contains(r"$ids = @('{6060EE11}', 'TCP Query User{E5}C:\x [1].exe')"));
        assert!(script.contains(r"-Program 'C:\x [1].exe' -Profile Any"));
        assert!(script.contains("-DisplayName 'AllySwally (program)'"));
        assert!(repair_script(r"C:\x.exe", &[]).contains("$ids = @()"));
    }

    #[test]
    fn manual_command_mentions_program_and_rule() {
        let cmd = manual_command(r"C:\Users\Me\Desktop\AllySwally.exe");
        assert!(cmd.contains(r"Where-Object Program -eq 'C:\Users\Me\Desktop\AllySwally.exe'"));
        assert!(cmd.contains("New-NetFirewallRule -DisplayName 'AllySwally (program)'"));
        assert!(cmd.contains("-Profile Any"));
    }

    #[test]
    fn encoded_command_reaches_powershell_intact() {
        // Harmless script; the quotes and braces would break naive quoting.
        let r = run_powershell("$x = @{ 'a''b' = 1 }; Write-Output ($x.Keys -join ',')");
        assert!(r.launched, "{:?}", r.error);
        assert_eq!(r.stdout.trim(), "a'b");
    }

    #[test]
    fn reads_the_real_rule_store() {
        // Read-only: a path no rule can name yields an empty list, not an error.
        assert_eq!(rules_for(r"C:\nowhere\allyswally-test-not-real.exe"), Ok(vec![]));
    }
}
