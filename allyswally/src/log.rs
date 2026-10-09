//! Structured logging to JSON Lines, with a console mirror and retention.
//!
//! Each event is one JSON object on its own line in `logs\<date>.jsonl`. Lines
//! are buffered and flushed once a second (and on shutdown) so a busy trackpad
//! session does not hammer the disk. The most recent entries are also kept in
//! an in-memory ring so the Settings → Diagnostics panel can show them without
//! reading files. Files older than the retention window are pruned at startup.
//!
//! Privacy: the content of typed text and clipboard payloads is never logged —
//! only a type and a count (e.g. "text input, 12 chars"). Executed commands,
//! being an audit trail, are logged in full.

use crate::json::{Obj, Value};
use crate::paths::write_atomic;
use crate::win::sysinfo::local_time;
use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

const RING_CAPACITY: usize = 500;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warning,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Warning => "warning",
            Level::Error => "error",
        }
    }
    /// ANSI colour for the console mirror.
    fn color(self) -> &'static str {
        match self {
            Level::Info => "\x1b[36m",    // cyan
            Level::Warning => "\x1b[33m", // yellow
            Level::Error => "\x1b[31m",   // red
        }
    }
    pub fn parse(s: &str) -> Option<Level> {
        match s {
            "info" => Some(Level::Info),
            "warning" => Some(Level::Warning),
            "error" => Some(Level::Error),
            _ => None,
        }
    }
}

struct Inner {
    pending: Vec<String>,
    ring: VecDeque<Value>,
    open: Option<(String, std::fs::File)>,
    logs_dir: PathBuf,
    retention_days: u64,
    quiet_console: bool,
}

pub struct Logger {
    inner: Mutex<Inner>,
}

impl Logger {
    pub fn new(logs_dir: PathBuf, retention_days: u64) -> Logger {
        Logger {
            inner: Mutex::new(Inner {
                pending: Vec::new(),
                ring: VecDeque::with_capacity(RING_CAPACITY),
                open: None,
                logs_dir,
                retention_days,
                quiet_console: false,
            }),
        }
    }

    /// Update the retention window after config reloads.
    pub fn set_retention(&self, days: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.retention_days = days;
        }
    }

    /// Record one event. `fields` are extra key/value pairs merged into the
    /// line after the standard `ts`, `level` and `event`.
    pub fn log(&self, level: Level, event: &str, fields: Vec<(String, Value)>) {
        let now = local_time();
        let mut obj = Obj::new()
            .str("ts", now.timestamp())
            .str("level", level.as_str())
            .str("event", event);
        for (k, v) in &fields {
            obj = obj.set(k, v.clone());
        }
        let value = obj.build();
        let line = value.to_string();

        self.console_mirror(level, event, &now.timestamp()[11..], &fields);

        if let Ok(mut inner) = self.inner.lock() {
            inner.pending.push(line);
            if inner.ring.len() == RING_CAPACITY {
                inner.ring.pop_front();
            }
            inner.ring.push_back(value);
        }
    }

    pub fn info(&self, event: &str, fields: Vec<(String, Value)>) {
        self.log(Level::Info, event, fields);
    }
    pub fn warn(&self, event: &str, fields: Vec<(String, Value)>) {
        self.log(Level::Warning, event, fields);
    }
    pub fn error(&self, event: &str, fields: Vec<(String, Value)>) {
        self.log(Level::Error, event, fields);
    }

    fn console_mirror(&self, level: Level, event: &str, time_only: &str, fields: &[(String, Value)]) {
        if let Ok(inner) = self.inner.lock() {
            if inner.quiet_console {
                return;
            }
        }
        let mut extras = String::new();
        for (k, v) in fields {
            let rendered = match v {
                Value::Str(s) => s.clone(),
                other => other.to_string(),
            };
            extras.push_str(&format!(" \x1b[90m{k}=\x1b[0m{rendered}"));
        }
        println!(
            "\x1b[90m{time}\x1b[0m {color}{level:>7}\x1b[0m {event}{extras}",
            time = time_only,
            color = level.color(),
            level = level.as_str(),
            event = event,
            extras = extras
        );
    }

    /// Append buffered lines to today's log file. Called every second by the
    /// flusher thread and once more on shutdown.
    pub fn flush(&self) {
        let mut inner = match self.inner.lock() {
            Ok(i) => i,
            Err(_) => return,
        };
        if inner.pending.is_empty() {
            return;
        }
        let date = local_time().date();
        // Reopen if the day rolled over or no file is open yet.
        let needs_open = match &inner.open {
            Some((d, _)) => *d != date,
            None => true,
        };
        if needs_open {
            let path = inner.logs_dir.join(format!("{date}.jsonl"));
            if let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) {
                inner.open = Some((date.clone(), file));
            } else {
                return;
            }
        }
        let lines = std::mem::take(&mut inner.pending);
        if let Some((_, file)) = inner.open.as_mut() {
            for line in lines {
                let _ = writeln!(file, "{line}");
            }
            let _ = file.flush();
        }
    }

    /// Delete log files older than the retention window. Best effort.
    pub fn prune(&self) {
        let (dir, retention) = match self.inner.lock() {
            Ok(i) => (i.logs_dir.clone(), i.retention_days),
            Err(_) => return,
        };
        let today = local_time();
        let cutoff_days = days_from_civil(today.year as i64, today.month as u32, today.day as u32)
            .saturating_sub(retention as i64);
        let cutoff = date_string(cutoff_days);
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(date) = name.strip_suffix(".jsonl") {
                    // Lexicographic comparison is valid for YYYY-MM-DD.
                    if date < cutoff.as_str() {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
    }

    /// The most recent entries, newest last, optionally filtered by level.
    pub fn recent(&self, limit: usize, level: Option<Level>) -> Vec<Value> {
        let inner = match self.inner.lock() {
            Ok(i) => i,
            Err(_) => return Vec::new(),
        };
        let mut out: Vec<Value> = inner
            .ring
            .iter()
            .filter(|v| match level {
                None => true,
                Some(l) => v.get_str("level") == Some(l.as_str()),
            })
            .cloned()
            .collect();
        if out.len() > limit {
            out = out.split_off(out.len() - limit);
        }
        out
    }

    /// Dump an extra copy of the ring to a file, used by "export logs" if ever
    /// needed; currently unused but kept as the one writer that bypasses the
    /// daily file via `write_atomic`.
    #[allow(dead_code)]
    pub fn snapshot_to(&self, path: &std::path::Path) {
        let entries = self.recent(RING_CAPACITY, None);
        let mut body = String::new();
        for e in entries {
            body.push_str(&e.to_string());
            body.push('\n');
        }
        let _ = write_atomic(path, body.as_bytes());
    }
}

// --- Civil date arithmetic (Howard Hinnant's algorithms) -------------------

/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) as i64 + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Inverse of `days_from_civil`, formatted as `YYYY-MM-DD`.
fn date_string(z: i64) -> String {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_roundtrip() {
        for &(y, m, d) in &[(1970, 1, 1), (2000, 2, 29), (2026, 10, 8), (1999, 12, 31)] {
            let days = days_from_civil(y, m, d);
            assert_eq!(date_string(days), format!("{:04}-{:02}-{:02}", y, m, d));
        }
    }

    #[test]
    fn epoch_is_zero() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
    }

    #[test]
    fn cutoff_subtracts_days() {
        let today = days_from_civil(2026, 10, 8);
        assert_eq!(date_string(today - 14), "2026-09-24");
    }
}
