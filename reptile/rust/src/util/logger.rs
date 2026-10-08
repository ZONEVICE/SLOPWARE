//! Tiny levelled logger. Reptile logs to stdout/stderr and lets whoever
//! started the process deal with it.
//!
//! Levels, from quietest to loudest: silent, error, warn, info, debug. The
//! line format is the Node.js implementation's:
//! `2026-10-07T21:05:09.123Z INFO  [reptile:host] message`.

use crate::util::time::{iso_timestamp, now_ms};
use std::fmt::Display;
use std::io::Write;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Silent = 0,
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
}

impl Level {
    /// Parse a level name; unknown names fall back to `info`.
    pub fn parse(name: &str) -> Level {
        match name.trim().to_ascii_lowercase().as_str() {
            "silent" => Level::Silent,
            "error" => Level::Error,
            "warn" => Level::Warn,
            "debug" => Level::Debug,
            _ => Level::Info,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Level::Silent => "silent",
            Level::Error => "error",
            Level::Warn => "warn",
            Level::Info => "info",
            Level::Debug => "debug",
        }
    }
}

#[derive(Clone)]
pub struct Logger {
    scope: Arc<str>,
    level: Level,
}

impl Logger {
    pub fn new(scope: &str, level: Level) -> Logger {
        Logger { scope: Arc::from(scope), level }
    }

    /// A logger that discards everything.
    pub fn silent() -> Logger {
        Logger::new("silent", Level::Silent)
    }

    pub fn level(&self) -> Level {
        self.level
    }

    pub fn enabled(&self, level: Level) -> bool {
        level != Level::Silent && level <= self.level
    }

    /// `log.child("host")` prints `[reptile:host]`.
    pub fn child(&self, scope: &str) -> Logger {
        Logger { scope: Arc::from(format!("{}:{scope}", self.scope)), level: self.level }
    }

    fn write(&self, level: Level, message: &dyn Display) {
        if !self.enabled(level) {
            return;
        }
        let line =
            format!("{} {:<5} [{}] {}\n", iso_timestamp(now_ms()), level.name().to_uppercase(), self.scope, message);
        // A closed terminal must never take the process down: ignore failures.
        if level <= Level::Warn {
            let _ = std::io::stderr().lock().write_all(line.as_bytes());
        } else {
            let _ = std::io::stdout().lock().write_all(line.as_bytes());
        }
    }

    pub fn error(&self, message: impl Display) {
        self.write(Level::Error, &message);
    }

    pub fn warn(&self, message: impl Display) {
        self.write(Level::Warn, &message);
    }

    pub fn info(&self, message: impl Display) {
        self.write(Level::Info, &message);
    }

    pub fn debug(&self, message: impl Display) {
        self.write(Level::Debug, &message);
    }
}
