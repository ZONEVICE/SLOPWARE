//! Syncing: receiving a directory hosted by another instance and keeping the
//! local copy identical to it, in both directions, in real time.
//!
//! Lifecycle of a session (the `state` shown in the interface):
//!
//! ```text
//!   connecting -> syncing -> live
//!                   ^          |  stream lost          PIN changed on host
//!                   |          +------------> reconnecting     -> pin_required
//!                   +-------------------------------+ (retries)      (user types it)
//!   host stopped hosting -> stopped      local directory lost -> error
//! ```
//!
//!  - `syncing` is a full three-way reconciliation (the planner). It runs when
//!    a session starts, after every reconnection, and whenever the live path
//!    meets something it cannot apply safely: it is what makes the engine
//!    self-healing.
//!  - `live` means both watchers are running and changes flow as they happen:
//!    host changes arrive on the NDJSON stream, local changes are pushed as
//!    requests.
//!
//! Every step that touches the local disk holds the engine's `disk` lock:
//! remote operations and reconciliations run one at a time on the serial
//! queue's thread, local change batches on the watcher's thread, and they
//! never interleave. Every connection gets a new generation number; queued
//! work and timers from an older generation quietly do nothing.
//!
//! The local index is the BASE: the state last known to be identical on both
//! machines. It changes only once the host confirmed an operation (or a
//! download was committed), never optimistically.

use crate::domain::activity::{ActivityLog, Entry};
use crate::domain::errors::{AppError, AppResult};
use crate::domain::identity::Identity;
use crate::domain::pin::assert_pin;
use crate::domain::planner::{hash_candidates, plan_sync, Action, ActionType};
use crate::domain::protocol::{bye, stream, Timing};
use crate::domain::transport::{
    peer_error, PeerApi, PeerError, PeerFactory, Probe, ProbeOptions, ProbeStatus, StreamHandle,
};
use crate::fs::entry::{is_temp_path, read_state_lossy, same_state, Kind, State};
use crate::fs::hash::hash_file;
use crate::fs::index::{commit_op, FileIndex};
use crate::fs::mutate::{
    ensure_directory, move_entry, remove_file, remove_stale_temp_files, remove_tree, set_mtime, stage_file,
};
use crate::fs::ops::SyncOp;
use crate::fs::path_check::check_sync_directory;
use crate::fs::walk::walk_all;
use crate::fs::watcher::{BatchHooks, Filters, WatchOwner, Watcher, WatcherTiming};
use crate::util::events::{Event, EventBus};
use crate::util::logger::Logger;
use crate::util::threads::Locked;
use crate::util::threads::{backoff_delay, every, run_pool, spawn, SerialQueue, Sleeper, Timer};
use crate::util::time::now_ms;
use crate::util::wire::{depth_of, is_same_or_inside, normalize, parent_of, resolve};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

/// Transfers in flight during a reconciliation.
const TRANSFER_CONCURRENCY: usize = 8;
/// Reconciliations in a row that may end with conflicts before giving up.
const MAX_RECONCILE_RETRIES: u32 = 3;

#[derive(Clone)]
struct Progress {
    phase: &'static str,
    done: u64,
    total: u64,
    bytes_done: u64,
    bytes_total: u64,
    current: Option<String>,
}

impl Progress {
    fn scanning() -> Progress {
        Progress { phase: "scanning", done: 0, total: 0, bytes_done: 0, bytes_total: 0, current: None }
    }

    fn to_json(&self) -> Value {
        json!({
            "phase": self.phase,
            "done": self.done,
            "total": self.total,
            "bytesDone": self.bytes_done,
            "bytesTotal": self.bytes_total,
            "current": self.current,
        })
    }
}

/// How a state change treats the notice shown with it.
enum Notice {
    Keep,
    Clear,
    Set(&'static str, String),
}

struct EngineState {
    state: &'static str,
    state_since: i64,
    progress: Option<Progress>,
    notice: Option<Value>,
    /// Paths the host refused because they are not shared there.
    rejected: BTreeSet<String>,
    /// Paths left alone because each side has a different kind of entry.
    conflicts: Vec<String>,
    generation: u64,
    stopped: bool,
    pin: String,
    reconnect_attempt: u32,
    reconnect_timer: Option<Timer>,
    reconnect_at: Option<i64>,
    reconcile_timer: Option<(u64, Timer)>,
    reconcile_generation: u64,
    reconcile_retries: u32,
    reconciling: bool,
    reconciling_generation: u64,
    last_synced_at: Option<i64>,
    timer_ids: u64,
}

/// One synchronisation session with one host.
pub struct Engine {
    peer: Arc<dyn PeerApi>,
    share: Value,
    host: Value,
    root: PathBuf,
    activity: Arc<ActivityLog>,
    bus: Arc<EventBus>,
    logger: Logger,
    timing: Timing,
    watcher_timing: WatcherTiming,
    queue: Arc<SerialQueue>,
    /// Held by whoever touches the local disk.
    disk: Mutex<()>,
    index: Mutex<FileIndex>,
    st: Mutex<EngineState>,
    watcher: Mutex<Option<Watcher>>,
    stream: Mutex<Option<Arc<dyn StreamHandle>>>,
    heartbeat: Mutex<Option<Arc<Sleeper>>>,
    myself: Weak<Engine>,
}

struct SyncHooks;

impl BatchHooks for SyncHooks {
    fn ignore(&self, wire: &str) -> bool {
        is_temp_path(wire)
    }
    fn ignore_inside(&self, _wire: &str) -> bool {
        false
    }
}

impl WatchOwner for Engine {
    fn batch(&self, diff: &mut dyn FnMut(&FileIndex, &mut dyn BatchHooks) -> Vec<SyncOp>) {
        let _disk = self.disk.locked();
        if self.st().stopped {
            return;
        }
        let ops = {
            let index = self.index.locked();
            diff(&index, &mut SyncHooks)
        };
        if !ops.is_empty() {
            self.push_local(ops);
        }
    }

    fn inspect(&self, look: &mut dyn FnMut(&FileIndex)) {
        look(&self.index.locked());
    }

    fn filters(&self) -> Filters {
        Filters { ignore: Box::new(is_temp_path), ignore_inside: Box::new(|_| false) }
    }

    fn root_missing(&self) {
        let Some(engine) = self.myself.upgrade() else { return };
        spawn("sync-fail", move || {
            let message = format!(
                "The local directory {} disappeared. Syncing stopped so that nothing is deleted on the host.",
                engine.root.display()
            );
            engine.fail(&message);
        });
    }

    fn report_error(&self, message: String) {
        self.logger.warn(format_args!("local watcher error: {message}"));
    }
}

fn op_path(op: &Value, key: &str) -> Option<String> {
    op.get(key).and_then(Value::as_str).and_then(|text| normalize(text, false))
}

impl Engine {
    fn st(&self) -> MutexGuard<'_, EngineState> {
        self.st.locked()
    }

    fn changed(&self) {
        self.bus.changed("syncing");
    }

    fn share_name(&self) -> String {
        self.share.get("name").and_then(Value::as_str).unwrap_or("").to_string()
    }

    fn share_id(&self) -> String {
        self.share.get("id").and_then(Value::as_str).unwrap_or("").to_string()
    }

    fn host_name(&self) -> String {
        self.host.get("hostname").and_then(Value::as_str).unwrap_or("").to_string()
    }

    fn set_state(&self, state: &'static str, notice: Notice) {
        let previous = {
            let mut st = self.st();
            match notice {
                Notice::Keep => {}
                Notice::Clear => st.notice = None,
                Notice::Set(kind, message) => st.notice = Some(json!({ "kind": kind, "message": message })),
            }
            if st.state == state {
                None
            } else {
                let previous = st.state;
                st.state = state;
                st.state_since = now_ms();
                Some(previous)
            }
        };
        if let Some(previous) = previous {
            self.bus.emit(Event::SyncState { state, previous });
        }
        self.changed();
    }

    fn online(&self) -> bool {
        matches!(self.st().state, "live" | "syncing")
    }

    fn generation(&self) -> u64 {
        self.st().generation
    }

    fn alive(&self, generation: u64) -> bool {
        let st = self.st();
        st.generation == generation && !st.stopped
    }

    pub fn status(&self) -> Value {
        let st = self.st();
        json!({
            "active": true,
            "state": st.state,
            "since": st.state_since,
            "address": self.peer.address(),
            "port": self.peer.port(),
            "protocol": self.peer.protocol(),
            "host": self.host,
            "share": self.share,
            "localPath": self.root.to_string_lossy(),
            "progress": st.progress.as_ref().map(Progress::to_json),
            "notice": st.notice,
            "lastSyncedAt": st.last_synced_at,
            "reconnect": if st.state == "reconnecting" { json!({ "attempt": st.reconnect_attempt, "at": st.reconnect_at }) } else { Value::Null },
            "rejected": st.rejected.iter().take(200).collect::<Vec<_>>(),
            "conflicts": st.conflicts.iter().take(200).collect::<Vec<_>>(),
            "activity": self.activity.recent(60),
        })
    }

    pub fn state(&self) -> &'static str {
        self.st().state
    }

    // --- Lifecycle --------------------------------------------------------------------

    fn start(self: &Arc<Self>) -> Result<(), PeerError> {
        std::fs::create_dir_all(&self.root).map_err(|error| PeerError::new("local_error", error.to_string()))?;
        remove_stale_temp_files(&self.root);
        self.activity.add(Entry::info(format!(
            "Connected to {} ({}:{}).",
            self.host_name(),
            self.peer.address(),
            self.peer.port()
        )));
        self.start_heartbeat();
        self.open_stream()
    }

    /// Start watching the local directory. Called once the first
    /// reconciliation is done: a first sync can write thousands of files, and
    /// every one of them would otherwise come back as a notification to
    /// examine and discard. The rescan right after catches anything the user
    /// changed in the meantime.
    fn start_watcher(self: &Arc<Self>) {
        if self.watcher.locked().is_some() || self.st().stopped {
            return;
        }
        let owner: Arc<dyn WatchOwner> = self.clone();
        let watcher = match Watcher::start(&self.root, owner, self.watcher_timing, self.logger.child("watch")) {
            Ok(watcher) => watcher,
            Err(error) => {
                self.logger.warn(format_args!("could not watch {}: {error}", self.root.display()));
                return;
            }
        };
        let state = self.state();
        if self.st().stopped || state == "stopped" || state == "error" {
            watcher.close();
            return;
        }
        watcher.rescan();
        *self.watcher.locked() = Some(watcher);
    }

    fn start_heartbeat(self: &Arc<Self>) {
        let engine = Arc::downgrade(self);
        let sleeper = every("sync-heartbeat", Duration::from_millis(self.timing.peer_heartbeat_ms), move || {
            let Some(engine) = engine.upgrade() else { return };
            if !engine.online() || engine.peer.token().is_none() {
                return;
            }
            let progress = engine
                .st()
                .progress
                .as_ref()
                .map(|p| json!({ "done": p.done, "total": p.total }))
                .unwrap_or(Value::Null);
            let state = engine.state();
            let _ = engine.peer.heartbeat(&json!({ "phase": state, "progress": progress }));
        });
        if let Some(previous) = self.heartbeat.locked().replace(sleeper) {
            previous.stop();
        }
    }

    fn open_stream(self: &Arc<Self>) -> Result<(), PeerError> {
        let generation = {
            let mut st = self.st();
            st.generation += 1;
            st.generation
        };
        self.queue.clear();
        let (on_message, on_close) = (Arc::downgrade(self), Arc::downgrade(self));
        let handle = self.peer.open_stream(
            Box::new(move |message| {
                if let Some(engine) = on_message.upgrade() {
                    engine.on_message(message, generation);
                }
            }),
            Box::new(move |error| {
                if let Some(engine) = on_close.upgrade() {
                    engine.on_stream_closed(error, generation);
                }
            }),
        )?;
        if !self.alive(generation) {
            handle.close();
            return Ok(());
        }
        *self.stream.locked() = Some(handle);
        Ok(())
    }

    fn close_stream(&self) {
        if let Some(stream) = self.stream.locked().take() {
            stream.close();
        }
    }

    fn on_message(self: &Arc<Self>, message: Value, generation: u64) {
        if !self.alive(generation) {
            return;
        }
        match message.get("type").and_then(Value::as_str) {
            Some(stream::HELLO) => {
                self.st().reconnect_attempt = 0;
                self.set_state("syncing", Notice::Clear);
                self.schedule_reconcile(0);
            }
            Some(stream::OPS) => {
                if let Some(Value::Array(ops)) = message.get("ops") {
                    let ops = ops.clone();
                    let engine = self.clone();
                    self.queue.push(move || engine.apply_remote(&ops, generation));
                }
            }
            Some(stream::BYE) => {
                let reason = message.get("reason").and_then(Value::as_str).unwrap_or("").to_string();
                let text = message.get("message").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_string);
                self.on_bye(&reason, text, generation);
            }
            _ => {} // heartbeats only keep the connection busy
        }
    }

    fn on_bye(self: &Arc<Self>, reason: &str, message: Option<String>, generation: u64) {
        {
            let mut st = self.st();
            if st.generation != generation {
                return;
            }
            st.generation += 1;
            st.progress = None;
        }
        self.cancel_reconcile();
        self.queue.clear();
        self.close_stream();
        self.peer.set_token(None);
        match reason {
            bye::PIN_CHANGED => {
                self.activity
                    .add(Entry::warning("The host changed the PIN. Syncing is paused until the new PIN is entered."));
                self.set_state(
                    "pin_required",
                    Notice::Set(
                        "warning",
                        message
                            .unwrap_or_else(|| "The host changed the PIN. Enter the new PIN to resume syncing.".into()),
                    ),
                );
            }
            bye::HOST_STOPPED => {
                self.activity
                    .add(Entry::warning(message.clone().unwrap_or_else(|| "The host stopped hosting.".into())));
                let notice = message.unwrap_or_else(|| format!("The host stopped hosting \"{}\".", self.share_name()));
                self.end("stopped", Notice::Set("warning", notice));
            }
            _ => {
                // Replaced or timed out: try again.
                self.set_state(
                    "reconnecting",
                    Notice::Set(
                        "warning",
                        message.unwrap_or_else(|| "The connection was interrupted. Reconnecting\u{2026}".into()),
                    ),
                );
                self.schedule_reconnect();
            }
        }
    }

    fn on_stream_closed(self: &Arc<Self>, error: Option<PeerError>, generation: u64) {
        {
            let mut st = self.st();
            if st.generation != generation || st.stopped {
                return;
            }
            if matches!(st.state, "pin_required" | "stopped" | "error") {
                return;
            }
            st.generation += 1;
            st.progress = None;
        }
        self.cancel_reconcile();
        self.queue.clear();
        self.stream.locked().take();
        self.logger.debug(format_args!("stream closed: {}", error.map(|e| e.message).unwrap_or_else(|| "end".into())));
        self.activity.add(Entry::warning("Lost the connection to the host. Reconnecting\u{2026}"));
        self.set_state(
            "reconnecting",
            Notice::Set("warning", "Lost the connection to the host. Reconnecting\u{2026}".into()),
        );
        self.schedule_reconnect();
    }

    fn schedule_reconnect(self: &Arc<Self>) {
        let delay = {
            let mut st = self.st();
            if let Some(timer) = st.reconnect_timer.take() {
                timer.cancel();
            }
            if st.stopped {
                return;
            }
            let delay = backoff_delay(st.reconnect_attempt, 1000, 10_000);
            st.reconnect_attempt += 1;
            st.reconnect_at = Some(now_ms() + delay as i64);
            delay
        };
        self.changed();
        let engine = Arc::downgrade(self);
        let timer = Timer::after(Duration::from_millis(delay), move || {
            if let Some(engine) = engine.upgrade() {
                engine.reconnect();
            }
        });
        self.st().reconnect_timer = Some(timer);
    }

    fn reconnect(self: &Arc<Self>) {
        {
            let st = self.st();
            if st.stopped || st.state != "reconnecting" {
                return;
            }
        }
        let attempt = (|| -> Result<(), PeerError> {
            let info = self.peer.ping()?;
            if info.get("uuid") != self.host.get("uuid") {
                self.end(
                    "stopped",
                    Notice::Set(
                        "warning",
                        format!("{} restarted. Start a new sync from the start screen.", self.host_name()),
                    ),
                );
                return Ok(());
            }
            let hosting_id = info.get("hosting").and_then(|h| h.get("id")).and_then(Value::as_str);
            if hosting_id != Some(self.share_id().as_str()) {
                self.end(
                    "stopped",
                    Notice::Set("warning", format!("The host is no longer hosting \"{}\".", self.share_name())),
                );
                return Ok(());
            }
            match self.open_stream() {
                Ok(()) => Ok(()),
                Err(error) if error.status == 401 => {
                    // The old session is gone on the host: open a new one with the PIN.
                    let pin = self.st().pin.clone();
                    self.authenticate(&pin)?;
                    self.open_stream()
                }
                Err(error) => Err(error),
            }
        })();
        let Err(error) = attempt else { return };
        {
            let st = self.st();
            if st.stopped || st.state != "reconnecting" {
                return;
            }
        }
        match error.code.as_str() {
            "pin_invalid" => self.set_state(
                "pin_required",
                Notice::Set("warning", "The host\u{2019}s PIN changed. Enter the new PIN to resume syncing.".into()),
            ),
            "not_hosting" => self.end(
                "stopped",
                Notice::Set("warning", format!("The host is no longer hosting \"{}\".", self.share_name())),
            ),
            code => {
                let message = if code == "busy" {
                    format!("{} Retrying\u{2026}", error.message)
                } else {
                    format!(
                        "The host cannot be reached ({}). Retrying\u{2026}",
                        if code.is_empty() { "error" } else { code }
                    )
                };
                self.set_state("reconnecting", Notice::Set("warning", message));
                self.schedule_reconnect();
            }
        }
    }

    fn authenticate(&self, pin: &str) -> Result<(), PeerError> {
        let result = self.peer.connect(pin, &self.root.to_string_lossy())?;
        let share_id = result.get("share").and_then(|s| s.get("id")).and_then(Value::as_str);
        if share_id != Some(self.share_id().as_str()) {
            return Err(PeerError {
                status: 409,
                code: "not_hosting".into(),
                message: "The host is hosting a different directory now.".into(),
                details: None,
            });
        }
        self.st().pin = pin.to_string();
        Ok(())
    }

    /// The user typed a new PIN after the host changed it.
    pub fn submit_pin(self: &Arc<Self>, pin: Option<&Value>) -> AppResult<Value> {
        let value = assert_pin(pin)?;
        let state = self.state();
        if state != "pin_required" && state != "reconnecting" {
            return Err(AppError::conflict("No PIN is needed right now.", "pin_not_needed"));
        }
        let result = (|| -> Result<(), AppError> {
            let info = self.peer.ping().map_err(|e| peer_error(&e, "The host could not be reached."))?;
            let hosting_id = info.get("hosting").and_then(|h| h.get("id")).and_then(Value::as_str);
            if info.get("uuid") != self.host.get("uuid") || hosting_id != Some(self.share_id().as_str()) {
                let message = format!("The host is no longer hosting \"{}\".", self.share_name());
                self.end("stopped", Notice::Set("warning", message.clone()));
                return Err(AppError::conflict(message, "not_hosting"));
            }
            self.authenticate(&value).map_err(|e| peer_error(&e, "The host could not be reached."))
        })();
        if let Err(error) = result {
            if error.code == "pin_invalid" {
                return Err(AppError::forbidden("Wrong PIN. Try again.", "pin_invalid"));
            }
            return Err(error);
        }
        if let Some(timer) = self.st().reconnect_timer.take() {
            timer.cancel();
        }
        self.activity.add(Entry::info("PIN accepted. Resuming."));
        self.set_state("connecting", Notice::Clear);
        if self.open_stream().is_err() {
            self.set_state(
                "reconnecting",
                Notice::Set("warning", "Could not reopen the connection. Retrying\u{2026}".into()),
            );
            self.schedule_reconnect();
        }
        Ok(self.status())
    }

    /// Terminal state: stop moving data, keep the status visible.
    fn end(&self, state: &'static str, notice: Notice) {
        {
            let mut st = self.st();
            st.generation += 1;
            st.progress = None;
            if let Some(timer) = st.reconnect_timer.take() {
                timer.cancel();
            }
        }
        self.cancel_reconcile();
        if let Some(heartbeat) = self.heartbeat.locked().take() {
            heartbeat.stop();
        }
        self.queue.clear();
        self.close_stream();
        if let Some(watcher) = self.watcher.locked().take() {
            watcher.close();
        }
        self.set_state(state, notice);
    }

    fn fail(&self, message: &str) {
        {
            let st = self.st();
            if st.stopped || st.state == "error" || st.state == "stopped" {
                return;
            }
        }
        self.activity.add(Entry::error(message));
        let peer = self.peer.clone();
        spawn("sync-disconnect", move || {
            let _ = peer.disconnect();
        });
        self.end("error", Notice::Set("error", message.to_string()));
    }

    fn stop(&self, notify_host: bool) {
        {
            let mut st = self.st();
            if st.stopped {
                return;
            }
            st.stopped = true;
            st.generation += 1;
            if let Some(timer) = st.reconnect_timer.take() {
                timer.cancel();
            }
        }
        self.cancel_reconcile();
        if let Some(heartbeat) = self.heartbeat.locked().take() {
            heartbeat.stop();
        }
        self.queue.clear();
        self.close_stream();
        if notify_host {
            let _ = self.peer.disconnect();
        }
        if let Some(watcher) = self.watcher.locked().take() {
            watcher.close();
        }
        // Let a task that is already running notice the new generation.
        self.queue.idle(Duration::from_secs(5));
        self.queue.close();
        self.peer.close();
    }

    // --- Reconciliation ----------------------------------------------------------------

    /// Run a reconciliation in `delay` ms (unless one is already pending or
    /// running for this connection). Public for diagnostics and tests.
    pub fn schedule_reconcile(self: &Arc<Self>, delay: u64) {
        let mut st = self.st();
        if st.stopped {
            return;
        }
        // A timer left over from an older connection must not block this one.
        if st.reconcile_timer.is_some() && st.reconcile_generation != st.generation {
            if let Some((_, timer)) = st.reconcile_timer.take() {
                timer.cancel();
            }
        }
        // A running reconciliation decides by itself whether another one is
        // needed; requests made from inside it would turn a permanent failure
        // into an endless loop.
        if st.reconcile_timer.is_some() || (st.reconciling && st.reconciling_generation == st.generation) {
            return;
        }
        let generation = st.generation;
        st.reconcile_generation = generation;
        st.timer_ids += 1;
        let id = st.timer_ids;
        let engine = Arc::downgrade(self);
        let timer = Timer::after(Duration::from_millis(delay), move || {
            let Some(engine) = engine.upgrade() else { return };
            {
                let mut st = engine.st();
                if st.reconcile_timer.as_ref().map(|(timer_id, _)| *timer_id) == Some(id) {
                    st.reconcile_timer = None;
                }
                if st.generation != generation || st.stopped {
                    return;
                }
            }
            let task = engine.clone();
            engine.queue.push(move || task.reconcile(generation));
        });
        st.reconcile_timer = Some((id, timer));
    }

    fn cancel_reconcile(&self) {
        if let Some((_, timer)) = self.st().reconcile_timer.take() {
            timer.cancel();
        }
    }

    fn is_rejected(&self, path: &str) -> bool {
        // A name the local OS cannot store (Windows reserved chars/names) is
        // skipped like an unshared path, so the planner never keeps retrying a
        // download that can never land, nor lets a munged name round-trip.
        !crate::fs::entry::is_os_representable(path)
            || self.st().rejected.iter().any(|rejected| is_same_or_inside(rejected, path))
    }

    /// A queue task.
    fn reconcile(self: &Arc<Self>, generation: u64) {
        let _disk = self.disk.locked();
        {
            let mut st = self.st();
            if st.generation != generation || st.stopped {
                return;
            }
            st.reconciling = true;
            st.reconciling_generation = generation;
        }
        let retry_in = self.reconcile_pass(generation);
        self.st().reconciling = false;
        if self.watcher.locked().is_none() && self.alive(generation) {
            self.start_watcher();
        }
        if retry_in > 0 {
            self.schedule_reconcile(retry_in);
        }
    }

    /// One full comparison and execution. Returns milliseconds until another
    /// pass should run, or 0.
    fn reconcile_pass(self: &Arc<Self>, generation: u64) -> u64 {
        self.set_state("syncing", Notice::Keep);
        self.st().progress = Some(Progress::scanning());
        self.changed();

        let outcome = (|| -> Result<Option<bool>, PeerError> {
            let manifest = self.peer.manifest()?;
            if !self.alive(generation) {
                return Ok(None);
            }
            if let Some(id) = manifest.get("share").and_then(|s| s.get("id")).and_then(Value::as_str) {
                if !id.is_empty() && id != self.share_id() {
                    self.end(
                        "stopped",
                        Notice::Set("warning", "The host is hosting a different directory now.".into()),
                    );
                    return Ok(None);
                }
            }
            let mut remote: HashMap<String, State> = HashMap::new();
            if let Some(Value::Array(entries)) = manifest.get("entries") {
                for entry in entries {
                    let Some(path) = op_path(entry, "path") else { continue };
                    if is_temp_path(&path) {
                        continue;
                    }
                    if let Some(state) = State::from_json(entry) {
                        remote.insert(path, state);
                    }
                }
            }
            let local_entries: HashMap<String, State> = walk_all(&self.root)
                .map_err(|error| PeerError::new("local_error", error.to_string()))?
                .into_iter()
                .collect();
            if !self.alive(generation) {
                return Ok(None);
            }
            let local: HashMap<String, State> = local_entries.iter().map(|(p, s)| (p.clone(), s.public())).collect();
            let base = self.index.locked().to_public_map();

            // Equal content with different mtimes is common before a first
            // sync (copies made by other means); hash those instead of copying.
            let mut equal_content = HashSet::new();
            let candidates = hash_candidates(&local, &remote, &base);
            if !candidates.is_empty() {
                if let Some(progress) = self.st().progress.as_mut() {
                    progress.phase = "comparing";
                }
                self.changed();
                let remote_hashes = self.peer.hashes(&candidates)?;
                for path in &candidates {
                    if !self.alive(generation) {
                        return Ok(None);
                    }
                    let Some(theirs) = remote_hashes.get(path) else { continue };
                    let ours = resolve(&self.root, path).ok().and_then(|absolute| hash_file(&absolute).ok());
                    if ours.as_ref() == Some(theirs) {
                        equal_content.insert(path.clone());
                    }
                }
            }

            let plan = plan_sync(&local, &remote, &base, &|path| self.is_rejected(path), &equal_content);
            self.st().conflicts = plan.conflicts.iter().map(|c| c.path.clone()).collect();
            for conflict in &plan.conflicts {
                let kind =
                    |state: &Option<State>| if state.map(|s| s.kind) == Some(Kind::Dir) { "directory" } else { "file" };
                self.activity.add(
                    Entry::warning(format!(
                        "\"{}\" is a {} here and a {} on the host. It was left alone.",
                        conflict.path,
                        kind(&conflict.local),
                        kind(&conflict.remote)
                    ))
                    .with_path(&conflict.path),
                );
            }
            Ok(Some(self.execute(&plan.actions, &local_entries, generation)))
        })();

        let needs_another = match outcome {
            Ok(None) => return 0,
            Ok(Some(incomplete)) => incomplete,
            Err(error) => {
                if !self.alive(generation) {
                    return 0;
                }
                self.logger.warn(format_args!("reconciliation failed: {}", error.message));
                self.st().progress = None;
                if error.status == 401 {
                    // The session vanished; the stream will close and trigger a reconnect.
                    return 0;
                }
                true
            }
        };

        if !self.alive(generation) {
            return 0;
        }
        {
            let mut st = self.st();
            st.progress = None;
            st.last_synced_at = Some(now_ms());
        }
        self.set_state("live", Notice::Keep);
        let mut st = self.st();
        if needs_another && st.reconcile_retries < MAX_RECONCILE_RETRIES {
            st.reconcile_retries += 1;
            return 1000 * st.reconcile_retries as u64;
        }
        st.reconcile_retries = 0;
        0
    }

    fn step(&self, path: &str, bytes: u64) {
        if let Some(progress) = self.st().progress.as_mut() {
            progress.done += 1;
            progress.bytes_done += bytes;
            progress.current = Some(path.to_string());
        }
        self.changed();
    }

    /// Carry out a plan. Returns true when something could not be completed
    /// and another reconciliation is worthwhile.
    fn execute(self: &Arc<Self>, actions: &[Action], local_entries: &HashMap<String, State>, generation: u64) -> bool {
        let take = |kind: ActionType| -> Vec<&Action> { actions.iter().filter(|a| a.kind == kind).collect() };
        let work = actions.iter().filter(|a| !matches!(a.kind, ActionType::InSync | ActionType::Forget)).count();
        let bytes_total: u64 =
            take(ActionType::Download).iter().map(|a| a.remote.map(|s| s.size).unwrap_or(0)).sum::<u64>()
                + take(ActionType::Upload).iter().map(|a| a.local.map(|s| s.size).unwrap_or(0)).sum::<u64>();
        self.st().progress = Some(Progress {
            phase: "transferring",
            done: 0,
            total: work as u64,
            bytes_done: 0,
            bytes_total,
            current: None,
        });
        self.changed();
        let mut incomplete = false;

        // Bookkeeping: what is already identical becomes the new base.
        {
            let mut index = self.index.locked();
            for action in take(ActionType::InSync) {
                if let Some(state) = local_entries.get(&action.path) {
                    index.set(&action.path, *state);
                }
            }
            for action in take(ActionType::Forget) {
                index.delete(&action.path);
            }
        }
        for action in take(ActionType::AdoptMtime) {
            if !self.alive(generation) {
                return false;
            }
            match set_mtime(&self.root, &action.path, action.remote.map(|r| r.mtime_ms).unwrap_or(0)) {
                Ok(Some(state)) => self.index.locked().set(&action.path, state),
                Ok(None) => {}
                Err(_) => incomplete = true,
            }
            self.step(&action.path, 0);
        }

        // Deletions, deepest first.
        let mut local_deletes = take(ActionType::LocalDelete);
        local_deletes.sort_by_key(|a| std::cmp::Reverse(depth_of(&a.path)));
        for action in local_deletes {
            if !self.alive(generation) {
                return false;
            }
            if let Err(message) = self.delete_local(&action.path, action.local) {
                self.logger.debug(format_args!("could not delete {}: {message}", action.path));
                incomplete = true;
            }
            self.step(&action.path, 0);
        }
        let mut remote_deletes = take(ActionType::RemoteDelete);
        remote_deletes.sort_by_key(|a| std::cmp::Reverse(depth_of(&a.path)));
        if !remote_deletes.is_empty() && self.alive(generation) {
            let mut ops = Vec::new();
            let mut commits = Vec::new();
            for action in &remote_deletes {
                if action.remote.map(|r| r.kind) == Some(Kind::Dir) {
                    ops.push(json!({ "op": "rmdir", "path": action.path }));
                    commits.push(SyncOp::Rmdir { path: action.path.clone() });
                } else {
                    let base = action.base.or(action.remote).map(|s| s.public().to_json());
                    ops.push(json!({ "op": "unlink", "path": action.path, "base": base }));
                    commits.push(SyncOp::Unlink { path: action.path.clone(), base: None });
                }
            }
            if self.send_ops(&ops, &commits) {
                incomplete = true;
            }
            for action in &remote_deletes {
                self.step(&action.path, 0);
            }
        }

        // Directories, shallowest first.
        let mut local_mkdirs = take(ActionType::LocalMkdir);
        local_mkdirs.sort_by_key(|a| depth_of(&a.path));
        for action in local_mkdirs {
            if !self.alive(generation) {
                return false;
            }
            if self.make_local_directory(&action.path, action.local).is_err() {
                incomplete = true;
            }
            self.step(&action.path, 0);
        }
        let mut remote_mkdirs = take(ActionType::RemoteMkdir);
        remote_mkdirs.sort_by_key(|a| depth_of(&a.path));
        if !remote_mkdirs.is_empty() && self.alive(generation) {
            let ops: Vec<Value> = remote_mkdirs.iter().map(|a| json!({ "op": "mkdir", "path": a.path })).collect();
            let commits: Vec<SyncOp> = remote_mkdirs
                .iter()
                .map(|a| SyncOp::Mkdir { path: a.path.clone(), state: local_entries.get(&a.path).copied() })
                .collect();
            if self.send_ops(&ops, &commits) {
                incomplete = true;
            }
            for action in &remote_mkdirs {
                self.step(&action.path, 0);
            }
        }

        // Transfers.
        let transfers: Vec<&Action> = take(ActionType::Download).into_iter().chain(take(ActionType::Upload)).collect();
        let failed = std::sync::atomic::AtomicBool::new(false);
        let failures = run_pool(
            &transfers,
            TRANSFER_CONCURRENCY,
            &|| !self.alive(generation),
            &|action: &&Action| -> Result<(), String> {
                if let Some(progress) = self.st().progress.as_mut() {
                    progress.current = Some(action.path.clone());
                }
                self.changed();
                let ok = if action.kind == ActionType::Download {
                    let ok = self.download(&action.path, action.local);
                    self.step(&action.path, action.remote.map(|r| r.size).unwrap_or(0));
                    ok
                } else {
                    let ok = self.upload(&action.path, action.base);
                    self.step(&action.path, action.local.map(|l| l.size).unwrap_or(0));
                    ok
                };
                if !ok {
                    failed.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                Ok(())
            },
        );
        if !failures.is_empty() || failed.load(std::sync::atomic::Ordering::SeqCst) {
            incomplete = true;
        }
        incomplete
    }

    // --- Local disk helpers -------------------------------------------------------------

    fn delete_local(&self, path: &str, expected: Option<State>) -> Result<(), String> {
        let absolute = resolve(&self.root, path)?;
        let Some(current) = read_state_lossy(&absolute) else {
            self.index.locked().delete_tree(path);
            return Ok(());
        };
        if current.kind == Kind::Dir {
            let (removed, kept) = {
                let index = self.index.locked();
                remove_tree(&self.root, path, &mut |wire, state| {
                    state.kind == Kind::Dir
                        || same_state(Some(state), index.get(wire))
                        || same_state(Some(state), expected.as_ref())
                })
                .map_err(|e| e.to_string())?
            };
            let mut index = self.index.locked();
            for wire in &removed {
                index.delete(wire);
            }
            if !kept.is_empty() {
                return Err(format!("{path} still holds {} item(s)", kept.len()));
            }
        } else {
            // Changed since the plan was made: leave it, the watcher will push it.
            if expected.is_some() && !same_state(Some(&current), expected.as_ref()) {
                return Err(format!("{path} changed locally"));
            }
            self.index.locked().delete(path);
            remove_file(&self.root, path).map_err(|e| e.to_string())?;
        }
        self.activity.add(Entry::op("received", if current.kind == Kind::Dir { "rmdir" } else { "unlink" }, path));
        Ok(())
    }

    fn make_local_directory(&self, path: &str, expected: Option<State>) -> Result<(), String> {
        let absolute = resolve(&self.root, path)?;
        if let Some(current) = read_state_lossy(&absolute) {
            if current.kind == Kind::File {
                // The host replaced a file with a directory, and the local file
                // is unchanged since then (otherwise the plan would conflict).
                if expected.is_some() && !same_state(Some(&current), expected.as_ref()) {
                    return Err(format!("{path} changed locally"));
                }
                self.index.locked().delete(path);
                remove_file(&self.root, path).map_err(|e| e.to_string())?;
            }
        }
        let created = ensure_directory(&self.root, path).map_err(|e| e.to_string())?;
        {
            let mut index = self.index.locked();
            for (wire, state) in &created {
                index.set(wire, *state);
            }
            if let Some(state) = read_state_lossy(&absolute).filter(|s| s.kind == Kind::Dir) {
                index.set(path, state);
            }
        }
        if !created.is_empty() {
            self.activity.add(Entry::op("received", "mkdir", path));
        }
        Ok(())
    }

    /// Download one file from the host and commit it. False when it had to be
    /// skipped or failed. `expect_local` is the local state the decision was
    /// based on.
    fn download(self: &Arc<Self>, path: &str, expect_local: Option<State>) -> bool {
        let result = (|| -> Result<bool, String> {
            let absolute = resolve(&self.root, path)?;
            if read_state_lossy(&absolute).map(|s| s.kind) == Some(Kind::Dir) {
                // The host replaced a directory with a file; the planner made
                // sure the directory's content was removed first.
                let (_, kept) = remove_tree(&self.root, path, &mut |_, state| state.kind == Kind::Dir)
                    .map_err(|e| e.to_string())?;
                if !kept.is_empty() {
                    return Ok(false);
                }
                self.index.locked().delete_tree(path);
            }
            let created = ensure_directory(&self.root, parent_of(path)).map_err(|e| e.to_string())?;
            {
                let mut index = self.index.locked();
                for (wire, state) in &created {
                    index.set(wire, *state);
                }
            }
            let mut remote = self.peer.download(path).map_err(|e| e.message)?;
            let staged = stage_file(&self.root, path, &mut remote.body, Some(remote.size), remote.mtime_ms)
                .map_err(|e| e.to_string())?;
            let now = read_state_lossy(&absolute);
            let unchanged_locally = {
                let index = self.index.locked();
                same_state(now.as_ref(), expect_local.as_ref()) || same_state(now.as_ref(), index.get(path))
            };
            if now.map(|s| s.kind) == Some(Kind::File) && !unchanged_locally {
                // Edited locally while downloading: keep the local edit, plan again.
                staged.discard();
                self.schedule_reconcile(400);
                return Ok(false);
            }
            let base = {
                let mut index = self.index.locked();
                let base = index.get(path).copied();
                index.set(path, staged.state);
                base
            };
            if let Err(error) = staged.commit() {
                // Put the base back (a locked target fails here on Windows).
                // Forgetting it would leave the next reconciliation deciding by
                // mtime alone, and a host that just restored an older copy
                // would get the stale local one uploaded over it.
                {
                    let mut index = self.index.locked();
                    match base {
                        Some(state) => index.set(path, state),
                        None => index.delete(path),
                    }
                }
                staged.discard();
                return Err(error.to_string());
            }
            self.activity.add(Entry::op("received", "write", path).with_size(remote.size));
            Ok(true)
        })();
        match result {
            Ok(ok) => ok,
            Err(message) => {
                self.logger.debug(format_args!("download of {path} failed: {message}"));
                false
            }
        }
    }

    /// Upload one local file. False when it was refused or failed.
    fn upload(self: &Arc<Self>, path: &str, base: Option<State>) -> bool {
        let Ok(absolute) = resolve(&self.root, path) else { return false };
        let Some(current) = read_state_lossy(&absolute).filter(|s| s.kind == Kind::File) else {
            return true; // gone meanwhile: the watcher reports it
        };
        let base = base.map(|b| b.public());
        match self.peer.upload(path, &absolute, current.size, current.mtime_ms, base.as_ref()) {
            Ok(_) => {
                self.index.locked().set(path, current);
                self.activity.add(Entry::op("sent", "write", path).with_size(current.size));
                true
            }
            Err(error) => self.handle_refusal(&error.code, &error.message, path),
        }
    }

    /// Interpret a refused request.
    fn handle_refusal(self: &Arc<Self>, code: &str, message: &str, path: &str) -> bool {
        match code {
            "not_shared" => {
                let fresh = self.st().rejected.insert(path.to_string());
                if fresh {
                    self.activity.add(
                        Entry::warning(format!("\"{path}\" was not synced: the host does not share that path."))
                            .with_path(path),
                    );
                    self.changed();
                }
            }
            "conflict" => self.schedule_reconcile(400),
            _ => {
                self.logger.debug(format_args!("request for {path} failed: {message}"));
                self.schedule_reconcile(2000);
            }
        }
        false
    }

    /// Send non-content operations and commit each confirmed one to the
    /// index. True when something was not applied cleanly.
    fn send_ops(self: &Arc<Self>, ops: &[Value], commits: &[SyncOp]) -> bool {
        let results = match self.peer.ops(ops) {
            Ok(results) => results,
            Err(error) => {
                let first = ops
                    .first()
                    .and_then(|op| op.get("path").or_else(|| op.get("from")))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                self.handle_refusal(&error.code, &error.message, first);
                return true;
            }
        };
        let mut incomplete = false;
        for (index, op) in ops.iter().enumerate() {
            let result = results.get(index).cloned().unwrap_or_else(|| json!({ "ok": false }));
            let path = op.get("path").or_else(|| op.get("from")).and_then(Value::as_str).unwrap_or("").to_string();
            let name = op.get("op").and_then(Value::as_str).unwrap_or("");
            if result.get("ok").and_then(Value::as_bool) == Some(true) {
                commit_op(&mut self.index.locked(), &commits[index]);
                let to = op.get("to").and_then(Value::as_str);
                self.activity.add(Entry::op("sent", name, &path).with_to(to));
                if result.get("partial").and_then(Value::as_bool) == Some(true) {
                    incomplete = true;
                    self.schedule_reconcile(400);
                }
            } else {
                incomplete = true;
                let code = result.get("code").and_then(Value::as_str).unwrap_or("");
                let message = result.get("message").and_then(Value::as_str).unwrap_or("");
                let target = op.get("to").and_then(Value::as_str).map(str::to_string).unwrap_or(path);
                self.handle_refusal(code, message, &target);
            }
        }
        incomplete
    }

    // --- Live: local changes -> host ------------------------------------------------------

    /// Called by the watcher, under the disk lock, with each batch.
    fn push_local(&self, ops: Vec<SyncOp>) {
        let Some(engine) = self.myself.upgrade() else { return };
        {
            let mut index = self.index.locked();
            for op in &ops {
                if matches!(op, SyncOp::Reindex { .. }) {
                    commit_op(&mut index, op);
                }
            }
        }
        // Offline: nothing to do now. The reconciliation after reconnecting
        // compares against the base and pushes these changes then.
        if !self.online() || self.peer.token().is_none() {
            return;
        }
        let generation = self.generation();
        let mut batch: Vec<Value> = Vec::new();
        let mut commits: Vec<SyncOp> = Vec::new();
        let flush = |batch: &mut Vec<Value>, commits: &mut Vec<SyncOp>| {
            if !batch.is_empty() {
                engine.send_ops(&std::mem::take(batch), &std::mem::take(commits));
            }
        };
        for op in ops {
            if !self.alive(generation) {
                return;
            }
            if matches!(op, SyncOp::Reindex { .. }) {
                continue;
            }
            let target = match &op {
                SyncOp::Rename { to, .. } => to.clone(),
                other => other.path().to_string(),
            };
            if self.is_rejected(&target) && !matches!(op, SyncOp::Unlink { .. } | SyncOp::Rmdir { .. }) {
                continue;
            }
            match &op {
                SyncOp::Write { path, base, .. } => {
                    flush(&mut batch, &mut commits);
                    engine.upload(path, *base);
                    continue;
                }
                SyncOp::Rename { from, to, kind, .. } => {
                    let base = self.index.locked().get(from).copied();
                    let mut wire = json!({ "op": "rename", "from": from, "to": to, "kind": kind.as_str() });
                    if *kind == Kind::File {
                        if let Some(base) = base {
                            wire["base"] = base.public().to_json();
                        }
                    }
                    batch.push(wire);
                }
                SyncOp::Unlink { path, base } => {
                    let mut wire = json!({ "op": "unlink", "path": path });
                    if let Some(base) = base {
                        wire["base"] = base.public().to_json();
                    }
                    batch.push(wire);
                }
                other => batch.push(json!({ "op": other.name(), "path": other.path() })),
            }
            commits.push(op);
        }
        flush(&mut batch, &mut commits);
    }

    // --- Live: host changes -> local disk ---------------------------------------------------

    /// A queue task.
    fn apply_remote(self: &Arc<Self>, ops: &[Value], generation: u64) {
        let _disk = self.disk.locked();
        for op in ops {
            if !self.alive(generation) {
                return;
            }
            if let Err(message) = self.apply_remote_one(op) {
                self.logger.debug(format_args!(
                    "could not apply {} from the host: {message}",
                    op.get("op").and_then(Value::as_str).unwrap_or("?")
                ));
                self.schedule_reconcile(400);
            }
        }
        self.st().last_synced_at = Some(now_ms());
        self.changed();
    }

    fn apply_remote_one(self: &Arc<Self>, op: &Value) -> Result<(), String> {
        let name = op.get("op").and_then(Value::as_str).unwrap_or("");
        let Some(path) = op_path(op, if name == "rename" { "from" } else { "path" }) else { return Ok(()) };
        if is_temp_path(&path) {
            return Ok(());
        }
        let absolute = resolve(&self.root, &path)?;
        let current = read_state_lossy(&absolute);
        let known = self.index.locked().get(&path).copied();

        match name {
            "mkdir" => {
                if let Some(current) = current {
                    if current.kind == Kind::Dir {
                        self.index.locked().set(&path, current);
                        return Ok(());
                    }
                    if current.kind == Kind::File && same_state(Some(&current), known.as_ref()) {
                        self.index.locked().delete(&path);
                        remove_file(&self.root, &path).map_err(|e| e.to_string())?;
                    } else {
                        self.schedule_reconcile(400);
                        return Ok(());
                    }
                }
                self.make_local_directory(&path, None)
            }
            "write" => {
                let remote = State::file(
                    crate::fs::entry::number(op.get("size")) as u64,
                    crate::fs::entry::number(op.get("mtimeMs")) as i64,
                );
                if let Some(current) = current {
                    if same_state(Some(&current), Some(&remote)) {
                        self.index.locked().set(&path, current);
                        return Ok(());
                    }
                    if current.kind != Kind::File || !same_state(Some(&current), known.as_ref()) {
                        // Local edits not yet on the host: the planner decides who wins.
                        self.schedule_reconcile(400);
                        return Ok(());
                    }
                }
                // A failed download (e.g. the target is locked on Windows) must not
                // be dropped silently, or the two sides diverge while reporting
                // "live": reconcile so the file is retried once the obstacle clears.
                if !self.download(&path, current) {
                    self.schedule_reconcile(400);
                }
                Ok(())
            }
            "unlink" => {
                let Some(current) = current else {
                    self.index.locked().delete(&path);
                    return Ok(());
                };
                if current.kind == Kind::File && same_state(Some(&current), known.as_ref()) {
                    self.index.locked().delete(&path);
                    remove_file(&self.root, &path).map_err(|e| e.to_string())?;
                    self.activity.add(Entry::op("received", "unlink", &path));
                    return Ok(());
                }
                self.schedule_reconcile(400);
                Ok(())
            }
            "rmdir" => {
                let Some(current) = current else {
                    self.index.locked().delete_tree(&path);
                    return Ok(());
                };
                if current.kind != Kind::Dir {
                    self.schedule_reconcile(400);
                    return Ok(());
                }
                let (removed, kept) = {
                    let index = self.index.locked();
                    remove_tree(&self.root, &path, &mut |wire, state| {
                        state.kind == Kind::Dir || same_state(Some(state), index.get(wire))
                    })
                    .map_err(|e| e.to_string())?
                };
                {
                    let mut index = self.index.locked();
                    for wire in &removed {
                        index.delete(wire);
                    }
                }
                self.activity.add(Entry::op("received", "rmdir", &path));
                if !kept.is_empty() {
                    self.schedule_reconcile(400);
                }
                Ok(())
            }
            "rename" => {
                let Some(to) = op_path(op, "to") else { return Ok(()) };
                let target = read_state_lossy(&resolve(&self.root, &to)?);
                let known_target = self.index.locked().get(&to).copied();
                if current.is_none() && target.is_some() && same_state(target.as_ref(), known_target.as_ref()) {
                    return Ok(()); // already done
                }
                let in_sync = match (current, known) {
                    (Some(c), Some(k)) => c.kind == k.kind && (c.kind == Kind::Dir || same_state(Some(&c), Some(&k))),
                    _ => false,
                };
                if in_sync && target.is_none() {
                    self.index.locked().rekey(&path, &to);
                    match move_entry(&self.root, &path, &to) {
                        Ok(created) => {
                            let mut index = self.index.locked();
                            for (wire, state) in &created {
                                index.set(wire, *state);
                            }
                        }
                        Err(error) => {
                            self.index.locked().rekey(&to, &path);
                            return Err(error.to_string());
                        }
                    }
                    self.activity.add(Entry::op("received", "rename", &path).with_to(Some(&to)));
                    return Ok(());
                }
                self.schedule_reconcile(400);
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Process pending local changes and queued work (tests).
    pub fn settle(&self) {
        if let Some(watcher) = self.watcher.locked().as_ref() {
            watcher.flush();
        }
        self.queue.idle(Duration::from_secs(30));
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// A successful handshake, not yet started.
pub struct Prepared {
    peer: Arc<dyn PeerApi>,
    info: Value,
    session: Value,
    local_path: PathBuf,
    pin: String,
}

pub struct SyncingService {
    bus: Arc<EventBus>,
    identity: Arc<Identity>,
    timing: Timing,
    watcher_timing: WatcherTiming,
    peer_factory: PeerFactory,
    probe: Probe,
    logger: Logger,
    pub activity: Arc<ActivityLog>,
    engine: Mutex<Option<Arc<Engine>>>,
}

fn valid_address(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b':' | b'%' | b'-'))
}

impl SyncingService {
    pub fn new(
        bus: Arc<EventBus>,
        identity: Arc<Identity>,
        timing: Timing,
        watcher_timing: WatcherTiming,
        peer_factory: PeerFactory,
        probe: Probe,
        logger: Logger,
    ) -> Arc<SyncingService> {
        Arc::new(SyncingService {
            activity: Arc::new(ActivityLog::new(bus.clone(), "syncing")),
            bus,
            identity,
            timing,
            watcher_timing,
            peer_factory,
            probe,
            logger,
            engine: Mutex::new(None),
        })
    }

    fn parse_target(address: Option<&Value>, port: Option<&Value>) -> AppResult<(String, u16)> {
        let host = address
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_string();
        if !valid_address(&host) {
            return Err(AppError::bad_request("Type the IP address of the other instance.", "bad_address"));
        }
        let number = match port {
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
            _ => None,
        };
        match number {
            Some(n) if n.fract() == 0.0 && (1.0..=65535.0).contains(&n) => Ok((host, n as u16)),
            _ => Err(AppError::bad_request("The port must be a number between 1 and 65535.", "bad_port")),
        }
    }

    /// Check what lives at an address: the manual connection form, and the
    /// first step of every handshake.
    pub fn inspect(&self, address: Option<&Value>, port: Option<&Value>) -> AppResult<Value> {
        let (host, port) = SyncingService::parse_target(address, port)?;
        let result = (self.probe)(&ProbeOptions {
            host: host.clone(),
            port,
            prefer_protocol: self.identity.protocol.to_string(),
            connect_timeout_ms: 2500,
            request_timeout_ms: 4000,
            skip_tcp_check: false,
            cancelled: None,
        });
        match result.status {
            ProbeStatus::Closed | ProbeStatus::Unreachable => Err(AppError::bad_request(
                format!(
                    "Nothing answered at {host}:{port}. Check the address, the port and that Reptile is running there."
                ),
                "unreachable",
            )),
            ProbeStatus::NotReptile => Err(AppError::bad_request(
                format!("Something answered at {host}:{port}, but it is not Reptile."),
                "not_reptile",
            )),
            ProbeStatus::Found => {
                let info = result.info.unwrap_or(Value::Null);
                let protocol = info.get("protocol").and_then(Value::as_str).unwrap_or("").to_string();
                let uuid = info.get("uuid").and_then(Value::as_str).unwrap_or("").to_string();
                Ok(json!({
                    "info": {
                        "uuid": uuid,
                        "hostname": info.get("hostname").cloned().unwrap_or(Value::Null),
                        "address": host,
                        "port": port,
                        "protocol": protocol,
                        "version": info.get("version").cloned().unwrap_or(Value::Null),
                        "mode": info.get("mode").cloned().unwrap_or(Value::Null),
                        "hosting": info.get("hosting").cloned().unwrap_or(Value::Null),
                    },
                    "compatible": protocol == self.identity.protocol,
                    "self": uuid == self.identity.uuid,
                }))
            }
        }
    }

    /// Verify everything and open a session on the host, without touching
    /// the local disk or this instance's mode yet. A wrong PIN fails here, so
    /// the user can simply try again.
    pub fn handshake(
        &self,
        address: Option<&Value>,
        port: Option<&Value>,
        local_path: Option<&Value>,
        pin: Option<&Value>,
    ) -> AppResult<Prepared> {
        let pin = assert_pin(pin)?;
        let check = check_sync_directory(local_path.and_then(Value::as_str));
        if !check.ok {
            return Err(AppError::bad_request(check.message, "invalid_path"));
        }
        let target = self.inspect(address, port)?;
        let info = &target["info"];
        let hostname = info["hostname"].as_str().unwrap_or("").to_string();
        if target["self"] == json!(true) {
            return Err(AppError::bad_request("That is this same instance. Choose another one.", "self"));
        }
        if target["compatible"] != json!(true) {
            return Err(AppError::bad_request(
                format!(
                    "Protocol mismatch: {hostname} runs {} and this instance runs {}. Both must use the same protocol.",
                    info["protocol"].as_str().unwrap_or("").to_uppercase(),
                    self.identity.protocol.to_uppercase()
                ),
                "protocol_mismatch",
            ));
        }
        if info["hosting"].is_null() {
            return Err(AppError::conflict(format!("{hostname} is not hosting a directory."), "not_hosting"));
        }
        let address = info["address"].as_str().unwrap_or("").to_string();
        let port = info["port"].as_u64().unwrap_or(0) as u16;
        let peer = (self.peer_factory)(&address, port, self.identity.protocol);
        let local = check.path.unwrap_or_default();
        match peer.connect(&pin, &local) {
            Ok(session) => Ok(Prepared { peer, info: info.clone(), session, local_path: PathBuf::from(local), pin }),
            Err(error) => {
                peer.close();
                let app = peer_error(&error, "The host could not be reached.");
                if app.code == "pin_invalid" {
                    return Err(AppError::forbidden("Wrong PIN. Try again.", "pin_invalid"));
                }
                Err(app)
            }
        }
    }

    /// Start the engine for a successful handshake.
    pub fn begin(&self, prepared: &Prepared) -> AppResult<Value> {
        self.stop();
        self.activity.clear();
        let engine = Arc::new_cyclic(|myself| Engine {
            peer: prepared.peer.clone(),
            share: prepared.session.get("share").cloned().unwrap_or(Value::Null),
            host: prepared.session.get("host").cloned().unwrap_or(Value::Null),
            root: prepared.local_path.clone(),
            activity: self.activity.clone(),
            bus: self.bus.clone(),
            logger: self.logger.clone(),
            timing: self.timing,
            watcher_timing: self.watcher_timing,
            queue: SerialQueue::new("sync-queue"),
            disk: Mutex::new(()),
            index: Mutex::new(FileIndex::new()),
            st: Mutex::new(EngineState {
                state: "connecting",
                state_since: now_ms(),
                progress: None,
                notice: None,
                rejected: BTreeSet::new(),
                conflicts: Vec::new(),
                generation: 0,
                stopped: false,
                pin: prepared.pin.clone(),
                reconnect_attempt: 0,
                reconnect_timer: None,
                reconnect_at: None,
                reconcile_timer: None,
                reconcile_generation: 0,
                reconcile_retries: 0,
                reconciling: false,
                reconciling_generation: 0,
                last_synced_at: None,
                timer_ids: 0,
            }),
            watcher: Mutex::new(None),
            stream: Mutex::new(None),
            heartbeat: Mutex::new(None),
            myself: myself.clone(),
        });
        let _ = &prepared.info;
        *self.engine.locked() = Some(engine.clone());
        if let Err(error) = engine.start() {
            self.engine.locked().take();
            engine.stop(true);
            return Err(peer_error(&error, "Could not start syncing."));
        }
        self.bus.changed("syncing");
        Ok(engine.status())
    }

    pub fn stop(&self) {
        let Some(engine) = self.engine.locked().take() else { return };
        let notify = engine.state() != "stopped";
        engine.stop(notify);
        self.bus.changed("syncing");
    }

    /// Abandon a handshake whose session will not be used.
    pub fn abandon(&self, prepared: &Prepared) {
        let _ = prepared.peer.disconnect();
        prepared.peer.close();
    }

    pub fn submit_pin(&self, pin: Option<&Value>) -> AppResult<Value> {
        let engine = self
            .engine()
            .ok_or_else(|| AppError::conflict("This instance is not syncing a directory.", "not_syncing"))?;
        engine.submit_pin(pin)
    }

    pub fn status(&self) -> Value {
        self.engine().map(|engine| engine.status()).unwrap_or(Value::Null)
    }

    pub fn active(&self) -> bool {
        self.engine.locked().is_some()
    }

    pub fn engine(&self) -> Option<Arc<Engine>> {
        self.engine.locked().clone()
    }

    /// Wait until the engine has nothing queued (tests).
    pub fn settle(&self) {
        if let Some(engine) = self.engine() {
            engine.settle();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::domain::transport::{Download, OnClose, OnMessage, PeerResult};
    use crate::fs::entry::read_state;
    use crate::util::ids::random_hex;
    use crate::util::logger::Level;
    use std::fs;
    use std::io::{self, Read};
    use std::os::unix::fs::PermissionsExt;

    /// A body that turns its directory read-only once fully read, so the
    /// commit's rename fails after staging, as a locked target does on Windows.
    struct LockAtEnd {
        data: io::Cursor<Vec<u8>>,
        dir: PathBuf,
    }

    impl Read for LockAtEnd {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let read = self.data.read(buf)?;
            if read == 0 {
                fs::set_permissions(&self.dir, fs::Permissions::from_mode(0o555))?;
            }
            Ok(read)
        }
    }

    /// A host that only serves downloads.
    struct DownloadOnly {
        content: Vec<u8>,
        mtime_ms: i64,
        dir: PathBuf,
    }

    impl PeerApi for DownloadOnly {
        fn address(&self) -> &str {
            "127.0.0.1"
        }
        fn port(&self) -> u16 {
            1
        }
        fn protocol(&self) -> &str {
            "http"
        }
        fn token(&self) -> Option<String> {
            None
        }
        fn set_token(&self, _: Option<String>) {}
        fn ping(&self) -> PeerResult<Value> {
            unimplemented!()
        }
        fn connect(&self, _: &str, _: &str) -> PeerResult<Value> {
            unimplemented!()
        }
        fn open_stream(&self, _: OnMessage, _: OnClose) -> PeerResult<Arc<dyn StreamHandle>> {
            unimplemented!()
        }
        fn manifest(&self) -> PeerResult<Value> {
            unimplemented!()
        }
        fn hashes(&self, _: &[String]) -> PeerResult<HashMap<String, String>> {
            unimplemented!()
        }
        fn download(&self, _: &str) -> PeerResult<Download> {
            let body = LockAtEnd { data: io::Cursor::new(self.content.clone()), dir: self.dir.clone() };
            Ok(Download { body: Box::new(body), size: self.content.len() as u64, mtime_ms: self.mtime_ms })
        }
        fn upload(&self, _: &str, _: &Path, _: u64, _: i64, _: Option<&State>) -> PeerResult<Value> {
            unimplemented!()
        }
        fn ops(&self, _: &[Value]) -> PeerResult<Vec<Value>> {
            unimplemented!()
        }
        fn heartbeat(&self, _: &Value) -> PeerResult<()> {
            unimplemented!()
        }
        fn disconnect(&self) -> PeerResult<()> {
            Ok(())
        }
        fn close(&self) {}
    }

    /// An engine that was never started: no stream, no watcher, no timers.
    fn idle_engine(peer: Arc<dyn PeerApi>, root: PathBuf) -> Arc<Engine> {
        let bus = EventBus::new(|_| {});
        Arc::new_cyclic(|myself| Engine {
            peer,
            share: Value::Null,
            host: Value::Null,
            root,
            activity: Arc::new(ActivityLog::new(bus.clone(), "syncing")),
            bus,
            logger: Logger::new("test", Level::Silent),
            timing: Timing::default(),
            watcher_timing: WatcherTiming::default(),
            queue: SerialQueue::new("test-sync-queue"),
            disk: Mutex::new(()),
            index: Mutex::new(FileIndex::new()),
            st: Mutex::new(EngineState {
                state: "live",
                state_since: 0,
                progress: None,
                notice: None,
                rejected: BTreeSet::new(),
                conflicts: Vec::new(),
                generation: 0,
                stopped: false,
                pin: String::new(),
                reconnect_attempt: 0,
                reconnect_timer: None,
                reconnect_at: None,
                reconcile_timer: None,
                reconcile_generation: 0,
                reconcile_retries: 0,
                reconciling: false,
                reconciling_generation: 0,
                last_synced_at: None,
                timer_ids: 0,
            }),
            watcher: Mutex::new(None),
            stream: Mutex::new(None),
            heartbeat: Mutex::new(None),
            myself: myself.clone(),
        })
    }

    #[test]
    fn a_failed_commit_keeps_the_base_it_was_decided_against() {
        // Root ignores directory permissions, so nothing would fail.
        // SAFETY: geteuid has no preconditions.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let root = std::env::temp_dir().join(format!("reptile-commit-{}", random_hex(4)));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("a.txt");
        fs::write(&target, b"local copy").unwrap();
        let base = read_state(&target).unwrap().unwrap();

        // The host restored an older copy: its mtime is earlier than the base's,
        // so without a base the next reconciliation would upload the local one.
        let host =
            DownloadOnly { content: b"restored".to_vec(), mtime_ms: base.mtime_ms - 3_600_000, dir: root.clone() };
        let engine = idle_engine(Arc::new(host), root.clone());
        engine.index.locked().set("a.txt", base);

        let committed = engine.download("a.txt", Some(base));
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        let kept = engine.index.locked().get("a.txt").copied();
        let content = fs::read(&target).unwrap();
        fs::remove_dir_all(&root).unwrap();

        assert!(!committed);
        assert_eq!(content, b"local copy");
        assert_eq!(kept, Some(base));
    }
}
