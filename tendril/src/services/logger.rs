//! JSON Lines logs in `~/.tendril/logs/YYYY-MM-DD.jsonl` (UTC days).
//!
//! Every line is one JSON object that starts with the same three fields:
//!
//! ```json
//! {"ts":"2026-10-14T12:00:00.123Z","level":"info","pid":4242,"event":"auth.login_ok","ip":"192.168.1.20"}
//! ```
//!
//! `pid` tells two instances sharing the directory apart. Lines are buffered
//! in memory and flushed every couple of seconds by a background task (see
//! `app.rs`), at once for warnings and errors, and on shutdown. Files older
//! than `log_retention_days` are deleted, and the whole directory is kept
//! under `log_max_total_mb` so a Raspberry Pi's SD card never fills up: once
//! today's file alone exceeds the cap, only warnings and errors are kept.
//!
//! Passwords, session tokens and file contents are never logged: only events
//! (`services::events`) and short messages reach this module.

use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use serde_json::Value;

use super::events::{Event, Level};
use crate::core::clock;
use crate::core::lock::LockExt;

/// Buffered, rotating JSON Lines writer.
pub struct Logger {
    dir: PathBuf,
    pid: u32,
    state: Mutex<State>,
    retention_days: AtomicU32,
    max_total_bytes: AtomicU64,
}

struct State {
    /// UTC day number of the open file.
    day: i64,
    file: Option<BufWriter<File>>,
    /// Size of today's file, including buffered bytes.
    bytes_today: u64,
    /// The size cap was hit today and the notice was written.
    capped: bool,
}

impl Logger {
    /// A logger writing into `dir` (created if missing).
    pub fn new(dir: impl Into<PathBuf>, retention_days: u32, max_total_mb: u64) -> Logger {
        let dir = dir.into();
        let _ = fs::create_dir_all(&dir);
        Logger {
            dir,
            pid: std::process::id(),
            state: Mutex::new(State { day: i64::MIN, file: None, bytes_today: 0, capped: false }),
            retention_days: AtomicU32::new(retention_days.max(1)),
            max_total_bytes: AtomicU64::new(max_total_mb.max(1) * 1024 * 1024),
        }
    }

    /// The directory the logs are written to.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Updates retention and size limits (from the Settings tab).
    pub fn set_limits(&self, retention_days: u32, max_total_mb: u64) {
        self.retention_days.store(retention_days.max(1), Ordering::Relaxed);
        self.max_total_bytes.store(max_total_mb.max(1) * 1024 * 1024, Ordering::Relaxed);
    }

    /// Logs an event from the bus.
    pub fn event(&self, event: &Event) {
        match serde_json::to_string(event) {
            Ok(body) => self.write_body(event.level(), &body),
            Err(err) => self.message(Level::Error, "log.serialize_failed", &err.to_string()),
        }
    }

    /// Logs a free-form message under an event name.
    pub fn message(&self, level: Level, event: &str, message: &str) {
        let body = serde_json::json!({ "event": event, "message": message });
        self.write_body(level, &body.to_string());
    }

    /// Logs an event name with arbitrary extra fields (`fields` must be an
    /// object; its keys are appended after `event`).
    pub fn fields(&self, level: Level, event: &str, fields: Value) {
        let mut map = serde_json::Map::new();
        map.insert("event".into(), Value::String(event.into()));
        if let Value::Object(extra) = fields {
            map.extend(extra);
        }
        self.write_body(level, &Value::Object(map).to_string());
    }

    /// Writes buffered lines to disk.
    pub fn flush(&self) {
        let mut state = self.state.locked();
        if let Some(file) = state.file.as_mut() {
            let _ = file.flush();
        }
    }

    /// Deletes logs older than the retention period, then the oldest files
    /// until the directory fits under the size cap (today's file is kept).
    pub fn prune(&self) {
        let today = clock::day_number(clock::unix_ms());
        let keep_days = self.retention_days.load(Ordering::Relaxed) as i64;
        let cap = self.max_total_bytes.load(Ordering::Relaxed);
        let mut files: Vec<(i64, PathBuf, u64)> = Vec::new();
        let Ok(entries) = fs::read_dir(&self.dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(day) = log_file_day(&path) else { continue };
            if day <= today - keep_days {
                let _ = fs::remove_file(&path);
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            files.push((day, path, size));
        }
        files.sort_by_key(|(day, _, _)| *day);
        let mut total: u64 = files.iter().map(|(_, _, size)| *size).sum();
        for (day, path, size) in files {
            if total <= cap || day >= today {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
    }

    /// Prefixes `ts`, `level` and `pid` to a serialized JSON object and
    /// appends it to today's file.
    fn write_body(&self, level: Level, body: &str) {
        let now = clock::unix_ms();
        let Some(rest) = body.strip_prefix('{') else { return };
        let separator = if rest.starts_with('}') { "" } else { "," };
        let line = format!(
            "{{\"ts\":\"{}\",\"level\":\"{}\",\"pid\":{}{separator}{rest}\n",
            clock::rfc3339_ms(now),
            level.as_str(),
            self.pid
        );

        let mut rotated = false;
        {
            let mut state = self.state.locked();
            let day = clock::day_number(now);
            if state.day != day || state.file.is_none() {
                if let Some(mut old) = state.file.take() {
                    let _ = old.flush();
                }
                let path = self.dir.join(format!("{}.jsonl", clock::date_string(day)));
                state.file = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                    .ok()
                    .map(|f| BufWriter::with_capacity(8 * 1024, f));
                state.bytes_today = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                state.capped = false;
                rotated = state.day != i64::MIN && state.day != day;
                state.day = day;
            }

            let cap = self.max_total_bytes.load(Ordering::Relaxed);
            if state.bytes_today >= cap && level < Level::Warn {
                if !state.capped {
                    state.capped = true;
                    let notice = format!(
                        "{{\"ts\":\"{}\",\"level\":\"warn\",\"pid\":{},\"event\":\"log.capped\",\"message\":\"log size cap reached; only warnings and errors are kept today\"}}\n",
                        clock::rfc3339_ms(now),
                        self.pid
                    );
                    if let Some(file) = state.file.as_mut() {
                        let _ = file.write_all(notice.as_bytes());
                    }
                }
                return;
            }

            state.bytes_today += line.len() as u64;
            if let Some(file) = state.file.as_mut() {
                let _ = file.write_all(line.as_bytes());
                if level >= Level::Warn {
                    let _ = file.flush();
                }
            }
        }
        if rotated {
            self.prune();
        }
    }

    /// Records a panic synchronously, bypassing the buffer and its lock (the
    /// panicking thread may hold it). Called from the panic hook right before
    /// the process aborts.
    pub fn record_panic(&self, message: &str) {
        if let Ok(mut state) = self.state.try_lock()
            && let Some(file) = state.file.as_mut()
        {
            let _ = file.flush();
        }
        let now = clock::unix_ms();
        let body = serde_json::json!({ "event": "panic", "message": message });
        let line = format!(
            "{{\"ts\":\"{}\",\"level\":\"error\",\"pid\":{},{}\n",
            clock::rfc3339_ms(now),
            self.pid,
            &body.to_string()[1..]
        );
        let path = self.dir.join(format!("{}.jsonl", clock::date_string(clock::day_number(now))));
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = file.write_all(line.as_bytes());
            let _ = file.sync_all();
        }
    }
}

/// The UTC day encoded in a `YYYY-MM-DD.jsonl` file name.
fn log_file_day(path: &Path) -> Option<i64> {
    let name = path.file_name()?.to_str()?;
    clock::parse_date(name.strip_suffix(".jsonl")?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::random;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tendril-logs-{}", random::token_hex(4)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn today_file(dir: &Path) -> PathBuf {
        dir.join(format!("{}.jsonl", clock::date_string(clock::day_number(clock::unix_ms()))))
    }

    #[test]
    fn writes_valid_json_lines() {
        let dir = temp_dir();
        let logger = Logger::new(&dir, 30, 50);
        logger.event(&Event::LoginOk { ip: "10.0.0.2".into() });
        logger.message(Level::Info, "test.message", "quote \" and newline \n inside");
        logger.fields(Level::Info, "test.fields", serde_json::json!({ "n": 3 }));
        logger.flush();
        let text = fs::read_to_string(today_file(&dir)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3);
        for line in &lines {
            let value: Value = serde_json::from_str(line).unwrap();
            assert!(value["ts"].as_str().unwrap().ends_with('Z'));
            assert_eq!(value["pid"], serde_json::json!(std::process::id()));
        }
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["event"], "auth.login_ok");
        assert_eq!(first["ip"], "10.0.0.2");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn prunes_by_age_and_size() {
        let dir = temp_dir();
        let today = clock::day_number(clock::unix_ms());
        for age in [1, 2, 40, 41] {
            fs::write(dir.join(format!("{}.jsonl", clock::date_string(today - age))), vec![b'x'; 600 * 1024]).unwrap();
        }
        fs::write(dir.join("unrelated.txt"), b"keep me").unwrap();
        let logger = Logger::new(&dir, 30, 1);
        logger.prune();
        let mut names: Vec<String> =
            fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        // 40 and 41 days old: past retention. 2 days old: over the 1 MiB cap.
        assert_eq!(names, vec![format!("{}.jsonl", clock::date_string(today - 1)), "unrelated.txt".to_string()]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_size_cap_keeps_only_warnings() {
        let dir = temp_dir();
        let logger = Logger::new(&dir, 30, 1);
        let filler = "y".repeat(1024);
        for _ in 0..1100 {
            logger.message(Level::Info, "filler", &filler);
        }
        logger.message(Level::Error, "important", "kept");
        logger.flush();
        let text = fs::read_to_string(today_file(&dir)).unwrap();
        assert!(text.contains("log.capped"));
        assert!(text.contains("important"));
        assert!(text.len() < 1024 * 1024 + 4096);
        fs::remove_dir_all(dir).unwrap();
    }
}
