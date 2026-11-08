//! Command-line options, parsed by hand from `std::env::args`.
//!
//! ```text
//! tendril [https|http] [--password <text>] [--port <n>] [--bind <ip>]
//! tendril --help | --version
//! ```
//!
//! HTTPS is the default; the bare word `http` serves plain HTTP. Options also
//! accept the `--name=value` form. Precedence for each value is command line,
//! then `settings.json`, then the built-in default.

use std::net::IpAddr;

/// Transport security for the listener.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Https,
    Http,
}

impl Scheme {
    /// `https` or `http`.
    pub fn as_str(self) -> &'static str {
        match self {
            Scheme::Https => "https",
            Scheme::Http => "http",
        }
    }
}

/// What the process was asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Run,
    Help,
    Version,
}

/// Parsed command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cli {
    pub action: Action,
    pub scheme: Scheme,
    pub password: Option<String>,
    pub port: Option<u16>,
    pub bind: Option<IpAddr>,
}

impl Default for Cli {
    fn default() -> Self {
        Cli { action: Action::Run, scheme: Scheme::Https, password: None, port: None, bind: None }
    }
}

/// Parses the arguments that follow the program name.
pub fn parse<I, S>(args: I) -> Result<Cli, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut cli = Cli::default();
    let mut args = args.into_iter().map(Into::into);
    while let Some(arg) = args.next() {
        // Split `--name=value` into its two halves.
        let (name, inline) = match arg.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        let mut value = |what: &str| -> Result<String, String> {
            match inline.clone().or_else(|| args.next()) {
                Some(v) if !v.is_empty() => Ok(v),
                _ => Err(format!("{name} needs {what}")),
            }
        };
        match name.as_str() {
            "http" => cli.scheme = Scheme::Http,
            "https" => cli.scheme = Scheme::Https,
            "--password" => cli.password = Some(value("a password")?),
            "--port" => {
                // 0 is passed through: it asks the OS for any free port, and the
                // banner reports the one actually bound (tests rely on it).
                let raw = value("a port number")?;
                cli.port = Some(raw.parse::<u16>().map_err(|_| format!("invalid port: {raw}"))?);
            }
            "--bind" => {
                let raw = value("an IP address")?;
                cli.bind = Some(raw.parse().map_err(|_| format!("invalid IP address: {raw}"))?);
            }
            "-h" | "--help" | "help" => cli.action = Action::Help,
            "-V" | "--version" | "version" => cli.action = Action::Version,
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(cli)
}

/// The `--help` text.
pub fn usage() -> String {
    format!(
        "Tendril {version} - a lightweight web code editor in a single binary.

USAGE:
    tendril [https|http] [OPTIONS]

MODES:
    https               Serve over HTTPS with a fresh self-signed certificate (default)
    http                Serve plain HTTP (no TLS; use only on trusted networks)

OPTIONS:
    --password <text>   Login password (overrides settings.json). Without one,
                        a random 8-character password is printed once.
    --port <n>          Port to listen on (default 6060; the next free port is
                        used when it is taken)
    --bind <ip>         Address to listen on (default 0.0.0.0, all interfaces)
    -h, --help          Show this help
    -V, --version       Show the version

Data, settings and logs live in ~/.tendril (%USERPROFILE%\\.tendril on Windows).",
        version = env!("CARGO_PKG_VERSION")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_https_and_run() {
        let cli = parse(Vec::<String>::new()).unwrap();
        assert_eq!(cli, Cli::default());
        assert_eq!(cli.scheme, Scheme::Https);
    }

    #[test]
    fn http_mode_and_options() {
        let cli = parse(["http", "--password", "s3cret", "--port=7000", "--bind", "127.0.0.1"]).unwrap();
        assert_eq!(cli.scheme, Scheme::Http);
        assert_eq!(cli.password.as_deref(), Some("s3cret"));
        assert_eq!(cli.port, Some(7000));
        assert_eq!(cli.bind, Some("127.0.0.1".parse().unwrap()));
    }

    #[test]
    fn passwords_may_contain_equals_signs() {
        let cli = parse(["--password=a=b=c"]).unwrap();
        assert_eq!(cli.password.as_deref(), Some("a=b=c"));
    }

    #[test]
    fn errors_are_reported() {
        assert!(parse(["--password"]).is_err());
        assert!(parse(["--port", "99999"]).is_err());
        assert!(parse(["--bind", "not-an-ip"]).is_err());
        assert!(parse(["--frobnicate"]).is_err());
    }

    #[test]
    fn help_and_version() {
        assert_eq!(parse(["--help"]).unwrap().action, Action::Help);
        assert_eq!(parse(["-V"]).unwrap().action, Action::Version);
        assert!(usage().contains("--password"));
    }
}
