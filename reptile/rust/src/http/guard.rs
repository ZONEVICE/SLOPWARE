//! Who may call what.
//!
//! One server answers two very different audiences on the same port: other
//! Reptile instances (`GET /api/ping` is public; the peer API is protected by
//! the PIN and then a bearer token), and the person at this computer, through
//! the control panel.
//!
//! The control panel shows the PIN and can host any directory the process can
//! read, so by default it only answers requests coming from this machine
//! (`--remote-ui` lifts that). It also refuses requests that a web page on
//! another site could forge in the user's browser: a foreign Origin, a
//! cross-site fetch, a non-JSON body, or a Host header that is not this
//! machine (DNS rebinding).

use crate::domain::errors::AppError;
use crate::domain::identity::InterfaceSource;
use crate::http::message::Headers;
use crate::http::server::Request;
use crate::util::net::{is_loopback_address, local_addresses, normalize_address};
use crate::util::threads::Locked;
use std::collections::BTreeSet;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Guard {
    allow_remote: bool,
    names: BTreeSet<String>,
    interfaces: InterfaceSource,
    own: Mutex<(Option<Instant>, BTreeSet<String>)>,
}

/// Host header without the port; handles "[::1]:55667".
fn host_only(header: &str) -> String {
    let value = header.trim().to_ascii_lowercase();
    if let Some(rest) = value.strip_prefix('[') {
        return rest.split(']').next().unwrap_or("").to_string();
    }
    match value.rfind(':') {
        Some(index) => value[..index].to_string(),
        None => value,
    }
}

impl Guard {
    pub fn new(allow_remote: bool, hostname: &str, interfaces: InterfaceSource) -> Guard {
        let lower = hostname.to_ascii_lowercase();
        let names = ["localhost".to_string(), lower.clone(), format!("{lower}.local")].into_iter().collect();
        Guard { allow_remote, names, interfaces, own: Mutex::new((None, BTreeSet::new())) }
    }

    fn own_addresses(&self) -> BTreeSet<String> {
        let mut own = self.own.locked();
        // Addresses can change (a laptop switching networks); re-read now and then.
        if own.0.map(|at| at.elapsed() > Duration::from_secs(10)).unwrap_or(true) {
            *own = (Some(Instant::now()), local_addresses(&(self.interfaces)()));
        }
        own.1.clone()
    }

    /// Check a control-panel request. None when allowed.
    pub fn check_ui(&self, request: &Request<'_>) -> Option<AppError> {
        self.check(&request.remote, &request.method, &request.headers)
    }

    /// The same check, on the parts of a request it looks at.
    pub fn check(&self, remote: &str, method: &str, headers: &Headers) -> Option<AppError> {
        let remote = normalize_address(remote);
        if !self.allow_remote && !is_loopback_address(&remote) && !self.own_addresses().contains(&remote) {
            return Some(AppError::forbidden(
                "The Reptile control panel only accepts connections from the computer it runs on. Open it there, or restart Reptile with --remote-ui to allow other computers.",
                "remote_ui_disabled",
            ));
        }
        let header = |name: &str| headers.get(name);
        let host = host_only(header("host").unwrap_or(""));
        if !host.is_empty() && host.parse::<IpAddr>().is_err() && !self.names.contains(&host) {
            return Some(AppError::forbidden(format!("Unexpected Host header \"{host}\"."), "bad_host"));
        }
        if method == "GET" || method == "HEAD" {
            return None;
        }
        let site = header("sec-fetch-site").unwrap_or("");
        if !site.is_empty() && site != "same-origin" && site != "none" {
            return Some(AppError::forbidden("Cross-site requests are not accepted.", "cross_site"));
        }
        if let Some(origin) = header("origin").filter(|o| !o.is_empty() && *o != "null") {
            let origin_host =
                origin.split_once("://").map(|(_, rest)| rest.split('/').next().unwrap_or("").to_ascii_lowercase());
            match origin_host {
                Some(origin_host) if !origin_host.is_empty() => {
                    if origin_host != header("host").unwrap_or("").to_ascii_lowercase() {
                        return Some(AppError::forbidden("Cross-origin requests are not accepted.", "cross_site"));
                    }
                }
                _ => return Some(AppError::forbidden("Malformed Origin header.", "cross_site")),
            }
        }
        let content_type =
            header("content-type").unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        if method != "DELETE" && content_type != "application/json" {
            return Some(AppError::unsupported_media("Expected an application/json body."));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::net::InterfaceAddress;
    use std::sync::Arc;

    fn guard(allow_remote: bool) -> Guard {
        let table = vec![InterfaceAddress {
            name: "eth0".into(),
            address: "192.168.1.10".parse().unwrap(),
            prefix: 24,
            internal: false,
            mac: "aa:bb:cc:dd:ee:ff".into(),
        }];
        Guard::new(allow_remote, "box", Arc::new(move || table.clone()))
    }

    fn headers(list: &[(&str, &str)]) -> Headers {
        let mut headers = Headers::new();
        headers.push("host", "127.0.0.1:55667");
        for (name, value) in list {
            headers.push(name, value);
        }
        headers
    }

    #[test]
    fn host_header_parsing() {
        assert_eq!(host_only("Example.local:55667"), "example.local");
        assert_eq!(host_only("[::1]:55667"), "::1");
        assert_eq!(host_only("localhost"), "localhost");
    }

    #[test]
    fn requests_from_this_computer_are_allowed_from_elsewhere_refused() {
        let g = guard(false);
        assert!(g.check("127.0.0.1", "GET", &headers(&[])).is_none());
        assert!(g.check("::ffff:127.0.0.1", "GET", &headers(&[])).is_none());
        assert!(g.check("192.168.1.10", "GET", &headers(&[])).is_none(), "our own LAN address");
        let refused = g.check("192.168.1.99", "GET", &headers(&[])).unwrap();
        assert_eq!((refused.status, refused.code.as_str()), (403, "remote_ui_disabled"));
        assert!(refused.message.contains("--remote-ui"));
        assert!(guard(true).check("192.168.1.99", "GET", &headers(&[])).is_none(), "--remote-ui opens the panel");
    }

    #[test]
    fn a_foreign_host_header_is_refused() {
        let g = guard(false);
        let with_host = |host: &str| {
            let mut h = Headers::new();
            h.push("host", host);
            g.check("127.0.0.1", "GET", &h)
        };
        assert_eq!(with_host("evil.example:55667").unwrap().code, "bad_host");
        assert!(with_host("localhost:55667").is_none());
        assert!(with_host("BOX.local:55667").is_none());
        assert!(with_host("[::1]:55667").is_none());
    }

    #[test]
    fn cross_site_writes_are_refused() {
        let g = guard(false);
        let json = ("content-type", "application/json");
        assert!(g.check("127.0.0.1", "POST", &headers(&[json, ("origin", "http://127.0.0.1:55667")])).is_none());
        assert_eq!(
            g.check("127.0.0.1", "POST", &headers(&[json, ("origin", "http://evil.example")])).unwrap().code,
            "cross_site"
        );
        assert_eq!(
            g.check("127.0.0.1", "POST", &headers(&[json, ("sec-fetch-site", "cross-site")])).unwrap().code,
            "cross_site"
        );
        assert_eq!(g.check("127.0.0.1", "POST", &headers(&[("content-type", "text/plain")])).unwrap().status, 415);
        assert!(g.check("127.0.0.1", "DELETE", &headers(&[])).is_none());
    }
}
