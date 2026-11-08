//! The publish/subscribe seam between the rules and everything that reacts to
//! them.
//!
//! Services announce what happened by publishing an [`Event`]; they never call
//! the logger or the console directly for audit facts. Subscribers (see
//! `crate::app::subscribers`) decide what to do: the audit log writes every
//! event as a JSON line, the console prints the ones an operator must see. A
//! new reaction - a metrics counter, a notification - is one new subscriber,
//! with no change to the code that publishes.
//!
//! Events carry only metadata: paths and IPs, never file contents, passwords
//! or session tokens.

use std::sync::{Arc, RwLock};

use serde::Serialize;

use crate::core::lock::RwLockExt;

/// Severity, as written in the `level` field of a log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    /// Lowercase name.
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

/// Something that happened. The serde tag is the `event` field of the log.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event")]
pub enum Event {
    #[serde(rename = "server.started")]
    Started { version: String, scheme: String, addr: String, data_dir: String, password_source: String },
    #[serde(rename = "server.stopping")]
    Stopping { reason: String },
    #[serde(rename = "server.settings_warning")]
    SettingsWarning { message: String },

    #[serde(rename = "auth.login_ok")]
    LoginOk { ip: String },
    #[serde(rename = "auth.login_failed")]
    LoginFailed { ip: String, failures: u8 },
    #[serde(rename = "auth.ip_blocked")]
    IpBlocked { ip: String },
    #[serde(rename = "auth.blocked_request")]
    BlockedRequest { ip: String, path: String },
    #[serde(rename = "auth.logout")]
    Logout { ip: String },
    #[serde(rename = "auth.password_changed")]
    PasswordChanged { ip: String },

    #[serde(rename = "security.rejected")]
    Rejected { ip: String, path: String, reason: String },

    #[serde(rename = "workspace.opened")]
    WorkspaceOpened { ip: String, path: String },

    /// A file operation inside a workspace. `path` is absolute.
    #[serde(rename = "fs")]
    FileOp {
        ip: String,
        op: String,
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        to: Option<String>,
    },

    /// A git operation (`op`: stage, unstage, discard, commit, checkout,
    /// branch, fetch, pull, push) on `paths` files; never messages or contents.
    #[serde(rename = "git")]
    GitOp { ip: String, op: String, paths: usize },

    #[serde(rename = "terminal.opened")]
    TerminalOpened { ip: String, id: u64, shell: String, cwd: String },
    #[serde(rename = "terminal.closed")]
    TerminalClosed { id: u64, reason: String },

    #[serde(rename = "settings.changed")]
    SettingsChanged { ip: String, keys: Vec<String> },

    #[serde(rename = "error")]
    Error { context: String, message: String },
}

impl Event {
    /// How serious the event is.
    pub fn level(&self) -> Level {
        match self {
            Event::Error { .. } => Level::Error,
            Event::LoginFailed { .. }
            | Event::IpBlocked { .. }
            | Event::BlockedRequest { .. }
            | Event::Rejected { .. }
            | Event::SettingsWarning { .. } => Level::Warn,
            _ => Level::Info,
        }
    }

    /// Shorthand for an error event.
    pub fn error(context: impl Into<String>, message: impl ToString) -> Event {
        Event::Error { context: context.into(), message: message.to_string() }
    }
}

/// A subscriber callback. It runs synchronously on the publisher's thread,
/// so it must be quick and must never block (buffer, then flush elsewhere).
pub type Subscriber = Arc<dyn Fn(&Event) + Send + Sync>;

/// The event bus.
#[derive(Default)]
pub struct Bus {
    subscribers: RwLock<Vec<Subscriber>>,
}

impl Bus {
    /// An empty bus.
    pub fn new() -> Bus {
        Bus::default()
    }

    /// Adds a subscriber; it sees every event published afterwards.
    pub fn subscribe(&self, subscriber: Subscriber) {
        self.subscribers.write_ok().push(subscriber);
    }

    /// Delivers `event` to every subscriber, in subscription order.
    pub fn publish(&self, event: Event) {
        // Clone the list so a subscriber may itself subscribe or publish.
        let subscribers = self.subscribers.read_ok().clone();
        for subscriber in subscribers {
            subscriber(&event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn subscribers_see_events_in_order() {
        let bus = Bus::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        bus.subscribe(Arc::new(move |e: &Event| sink.lock().unwrap().push(format!("{:?}", e.level()))));
        bus.publish(Event::LoginOk { ip: "1.2.3.4".into() });
        bus.publish(Event::IpBlocked { ip: "1.2.3.4".into() });
        assert_eq!(*seen.lock().unwrap(), vec!["Info", "Warn"]);
    }

    #[test]
    fn events_serialize_with_their_tag() {
        let json = serde_json::to_string(&Event::FileOp {
            ip: "::1".into(),
            op: "write".into(),
            path: "/w/a.txt".into(),
            to: None,
        })
        .unwrap();
        assert_eq!(json, r#"{"event":"fs","ip":"::1","op":"write","path":"/w/a.txt"}"#);
    }
}
