//! Hosting: sharing one directory with at most one connected peer.
//!
//! Responsibilities:
//!  - start/stop hosting, with a name, a PIN and a content selection;
//!  - watch the directory and announce every change to the connected peer;
//!  - answer the peer API (connect, manifest, files, operations, heartbeat)
//!    while enforcing the rules: one peer at a time, the PIN, unchecked items
//!    never leave the host and are never modified by the peer;
//!  - end the session when the PIN changes or hosting stops.
//!
//! The HTTP layer only translates requests into calls on this service; every
//! rule lives here.
//!
//! Locking: each share has a `disk` lock (index, selection, stats) that
//! serialises the watcher's batches and every change applied on the peer's
//! behalf. A change is written to the index BEFORE it reaches the disk, so the
//! notifications it causes find nothing new and are not echoed back. The
//! session has its own lock. Order: disk, then session; never the reverse.
//! Events are published after locks are released, except activity entries,
//! whose listeners never take a service lock.

use crate::domain::activity::{ActivityLog, Entry};
use crate::domain::errors::{from_fs, AppError, AppResult};
use crate::domain::identity::Identity;
use crate::domain::pin::{assert_pin, generate_pin, pin_matches, pin_missing};
use crate::domain::protocol::{bye, stream, Timing, PROTOCOL_VERSION};
use crate::domain::selection::Selection;
use crate::fs::entry::{is_temp_path, read_state, read_state_lossy, same_state, Kind, State};
use crate::fs::hash::hash_file;
use crate::fs::index::{commit_op, FileIndex};
use crate::fs::mutate::{
    ensure_directory, move_entry, move_tree_selective, remove_file, remove_stale_temp_files, remove_tree,
    resolve_safely, stage_file,
};
use crate::fs::ops::SyncOp;
use crate::fs::path_check::{check_host_directory, paths_overlap};
use crate::fs::walk::{walk_all, walk_tree, Decision, WalkOptions};
use crate::fs::watcher::{BatchHooks, Filters, WatchOwner, Watcher, WatcherTiming};
use crate::util::events::{Event, EventBus};
use crate::util::ids::{new_token, new_uuid, safe_eq};
use crate::util::logger::Logger;
use crate::util::threads::Locked;
use crate::util::threads::{every, spawn, Sleeper};
use crate::util::time::now_ms;
use crate::util::wire::{is_strictly_inside, normalize, parent_of, resolve};
use serde_json::{json, Map, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

const MAX_NAME_LENGTH: usize = 80;

/// The host -> peer NDJSON stream of one session, as a queue of lines that
/// the stream's HTTP connection writes out.
pub struct Sink {
    sender: Mutex<Option<Sender<String>>>,
}

impl Sink {
    pub fn new() -> (Arc<Sink>, Receiver<String>) {
        let (sender, receiver) = channel();
        (Arc::new(Sink { sender: Mutex::new(Some(sender)) }), receiver)
    }

    pub fn send(&self, message: &Value) {
        if let Some(sender) = self.sender.locked().as_ref() {
            let _ = sender.send(format!("{message}\n"));
        }
    }

    /// End the stream: the connection finishes its response.
    pub fn close(&self) {
        self.sender.locked().take();
    }
}

struct PeerInfo {
    uuid: String,
    hostname: String,
    address: String,
}

struct Session {
    token: String,
    peer: PeerInfo,
    since: i64,
    last_seen: i64,
    phase: String,
    progress: Value,
    sink: Option<Arc<Sink>>,
    heartbeat: Arc<Sleeper>,
}

impl Session {
    fn public(&self) -> Value {
        json!({
            "peer": { "uuid": self.peer.uuid, "hostname": self.peer.hostname, "address": self.peer.address },
            "since": self.since,
            "lastSeen": self.last_seen,
            "phase": self.phase,
            "streaming": self.sink.is_some(),
            "progress": self.progress,
        })
    }

    fn peer_json(&self) -> Value {
        json!({ "uuid": self.peer.uuid, "hostname": self.peer.hostname, "address": self.peer.address })
    }
}

struct ShareDisk {
    index: FileIndex,
    selection: Selection,
    stats: Option<Value>,
    stats_at: i64,
    stats_dirty: bool,
}

/// One hosted directory.
pub struct Share {
    pub id: String,
    pub name: String,
    pub root: PathBuf,
    pub started_at: i64,
    disk: Mutex<ShareDisk>,
    session: Mutex<Option<Session>>,
    pin: Mutex<String>,
    error: Mutex<Option<String>>,
    watcher: Mutex<Option<Watcher>>,
    stopped: AtomicBool,
    service: Weak<HostingService>,
}

impl Share {
    fn root_text(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    fn selection(&self) -> Selection {
        self.disk.locked().selection.clone()
    }
}

/// A file the peer wants to download.
pub struct OpenedFile {
    pub share: Arc<Share>,
    pub path: String,
    pub absolute: PathBuf,
    pub state: State,
}

/// An upload accepted from its headers, waiting for its body.
pub struct PreparedUpload {
    share: Arc<Share>,
    path: String,
    absolute: PathBuf,
    existing: Option<State>,
    pub unchanged: bool,
}

pub struct HostingService {
    bus: Arc<EventBus>,
    identity: Arc<Identity>,
    watcher_timing: WatcherTiming,
    timing: Timing,
    logger: Logger,
    pub activity: ActivityLog,
    current: Mutex<Option<Arc<Share>>>,
    notice: Mutex<Option<Value>>,
    active: AtomicBool,
    myself: Weak<HostingService>,
}

/// The batch's window onto the share: the selection decides what is visible.
struct HostHooks<'a> {
    selection: &'a mut Selection,
    logger: &'a Logger,
}

impl BatchHooks for HostHooks<'_> {
    fn ignore(&self, wire: &str) -> bool {
        // Temporary transfer files and the inside of unchecked directories are
        // invisible. Unchecked items themselves stay visible, so their renames
        // can be followed.
        is_temp_path(wire) || self.selection.has_excluded_ancestor(wire)
    }

    fn ignore_inside(&self, wire: &str) -> bool {
        self.selection.is_excluded(wire)
    }

    fn raw_add(&mut self, wire: &str, state: &State) {
        if self.selection.follow_identity(wire, state.id) {
            self.logger.debug(format_args!("unchecked item moved to {wire}; it stays unchecked"));
        }
    }
}

impl WatchOwner for Share {
    fn batch(&self, diff: &mut dyn FnMut(&FileIndex, &mut dyn BatchHooks) -> Vec<SyncOp>) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let Some(service) = self.service.upgrade() else { return };
        let mut guard = self.disk.locked();
        let disk = &mut *guard;
        let ops = {
            let mut hooks = HostHooks { selection: &mut disk.selection, logger: &service.logger };
            diff(&disk.index, &mut hooks)
        };
        if !ops.is_empty() {
            service.handle_local_ops(self, disk, ops);
        }
    }

    fn inspect(&self, look: &mut dyn FnMut(&FileIndex)) {
        look(&self.disk.locked().index);
    }

    fn filters(&self) -> Filters {
        let selection = Arc::new(self.selection());
        let inside = selection.clone();
        Filters {
            ignore: Box::new(move |wire| is_temp_path(wire) || selection.has_excluded_ancestor(wire)),
            ignore_inside: Box::new(move |wire| inside.is_excluded(wire)),
        }
    }

    fn root_missing(&self) {
        let Some(service) = self.service.upgrade() else { return };
        let id = self.id.clone();
        spawn("host-stop", move || {
            if service.current_share().map(|share| share.id == id).unwrap_or(false) {
                service.stop("root_missing");
            }
        });
    }

    fn report_error(&self, message: String) {
        *self.error.locked() = Some(message);
        if let Some(service) = self.service.upgrade() {
            service.changed();
        }
    }
}

fn shared_path(selection: &Selection, raw: Option<&Value>) -> AppResult<String> {
    let text = raw.and_then(Value::as_str);
    let Some(path) = text.and_then(|text| normalize(text, false)) else {
        let shown = match raw {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Null) | None => "undefined".into(),
            Some(other) => other.to_string(),
        };
        return Err(AppError::bad_request(format!("Invalid path: {shown}"), "bad_path"));
    };
    if is_temp_path(&path) {
        return Err(AppError::bad_request("Temporary transfer files cannot be synchronised.", "bad_path"));
    }
    if selection.is_excluded(&path) {
        return Err(AppError::forbidden(format!("\"{path}\" is not shared by the host."), "not_shared"));
    }
    Ok(path)
}

fn base_of(op: &Value) -> Option<State> {
    op.get("base").and_then(State::from_json)
}

impl HostingService {
    pub fn new(
        bus: Arc<EventBus>,
        identity: Arc<Identity>,
        watcher_timing: WatcherTiming,
        timing: Timing,
        logger: Logger,
    ) -> Arc<HostingService> {
        Arc::new_cyclic(|myself| HostingService {
            activity: ActivityLog::new(bus.clone(), "hosting"),
            bus,
            identity,
            watcher_timing,
            timing,
            logger,
            current: Mutex::new(None),
            notice: Mutex::new(None),
            active: AtomicBool::new(false),
            myself: myself.clone(),
        })
    }

    fn changed(&self) {
        self.bus.changed("hosting");
    }

    /// True while a directory is hosted.
    pub fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    fn current_share(&self) -> Option<Arc<Share>> {
        self.current.locked().clone()
    }

    fn require_share(&self) -> AppResult<Arc<Share>> {
        self.current_share()
            .ok_or_else(|| AppError::conflict("This instance is not hosting a directory.", "not_hosting"))
    }

    // --- Stats ---------------------------------------------------------------------

    fn compute_stats(disk: &mut ShareDisk) -> Value {
        let now = now_ms();
        if let Some(stats) = &disk.stats {
            if (!disk.stats_dirty && now - disk.stats_at < 60_000) || now - disk.stats_at < 500 {
                return stats.clone();
            }
        }
        let (mut files, mut dirs, mut bytes) = (0u64, 0u64, 0u64);
        for (path, state) in disk.index.iter() {
            if disk.selection.is_excluded(path) {
                continue;
            }
            if state.kind == Kind::File {
                files += 1;
                bytes += state.size;
            } else {
                dirs += 1;
            }
        }
        let stats = json!({ "files": files, "dirs": dirs, "bytes": bytes, "excluded": disk.selection.len() });
        disk.stats = Some(stats.clone());
        disk.stats_at = now;
        disk.stats_dirty = false;
        stats
    }

    // --- Sessions --------------------------------------------------------------------

    /// End the current session, telling the peer why when the stream is open.
    fn end_session(&self, share: &Share, reason: &str, message: &str) {
        let Some(session) = share.session.locked().take() else { return };
        session.heartbeat.stop();
        if let Some(sink) = &session.sink {
            sink.send(&json!({ "type": stream::BYE, "reason": reason, "message": message }));
            sink.close();
        }
        let label = match reason {
            bye::PIN_CHANGED => "was disconnected because the PIN changed",
            bye::HOST_STOPPED => "was disconnected because hosting stopped",
            bye::REPLACED => "reconnected",
            bye::TIMEOUT => "stopped responding and was disconnected",
            _ => "disconnected",
        };
        let entry = format!("{} {label}.", session.peer.hostname);
        self.activity.add(if reason == "left" || reason == bye::REPLACED {
            Entry::info(entry)
        } else {
            Entry::warning(entry)
        });
        self.bus.emit(Event::HostingPeerDisconnected { reason: reason.to_string(), peer: session.peer_json() });
        self.changed();
    }

    fn authorize(&self, token: &str) -> AppResult<Arc<Share>> {
        let share = self.require_share()?;
        {
            let mut session = share.session.locked();
            match session.as_mut() {
                Some(session) if !token.is_empty() && safe_eq(token, &session.token) => session.last_seen = now_ms(),
                _ => return Err(AppError::unauthorized()),
            }
        }
        Ok(share)
    }

    /// Throw `unauthorized` unless the token belongs to the current session.
    pub fn verify(&self, token: &str) -> AppResult<()> {
        self.authorize(token).map(|_| ())
    }

    // --- Local changes -> peer --------------------------------------------------------

    /// Runs under the disk lock, called by the watcher with each batch.
    fn handle_local_ops(&self, share: &Share, disk: &mut ShareDisk, ops: Vec<SyncOp>) {
        let mut outgoing: Vec<Value> = Vec::new();
        let mut logged: Vec<Entry> = Vec::new();
        for op in ops {
            match &op {
                SyncOp::Reindex { .. } => {
                    commit_op(&mut disk.index, &op);
                    continue;
                }
                SyncOp::Rename { from, to, kind, .. } => {
                    let from_excluded = disk.selection.is_excluded(from);
                    let to_excluded = disk.selection.is_excluded(to);
                    if disk.selection.apply_rename(from, to) {
                        self.logger.debug(format_args!("selection follows rename {from} -> {to}"));
                    }
                    commit_op(&mut disk.index, &op);
                    if from_excluded {
                        continue; // an unchecked item moved; nothing leaves the host
                    }
                    if to_excluded {
                        let name = if *kind == Kind::Dir { "rmdir" } else { "unlink" };
                        outgoing.push(json!({ "op": name, "path": from }));
                        logged.push(Entry::op("sent", name, from));
                        continue;
                    }
                    outgoing.push(op.to_wire());
                    logged.push(Entry::op("sent", "rename", from).with_to(Some(to)));
                    continue;
                }
                SyncOp::Write { path, state, .. } | SyncOp::Mkdir { path, state }
                    if disk.selection.follow_identity(path, state.and_then(|s| s.id)) =>
                {
                    // An unchecked item reappeared under a new name: it stays unchecked.
                    commit_op(&mut disk.index, &op);
                    continue;
                }
                _ => {}
            }
            commit_op(&mut disk.index, &op);
            if disk.selection.is_excluded(op.path()) {
                continue;
            }
            // A write is logged when the peer actually downloads it.
            if op.name() != "write" {
                logged.push(Entry::op("sent", op.name(), op.path()));
            }
            outgoing.push(op.to_wire());
        }
        disk.stats_dirty = true;

        if !outgoing.is_empty() {
            let session = share.session.locked();
            if let Some(sink) = session.as_ref().and_then(|s| s.sink.clone()) {
                drop(session);
                sink.send(&json!({ "type": stream::OPS, "ops": outgoing }));
                for entry in logged {
                    self.activity.add(entry);
                }
            }
        }
        self.changed();
    }

    // --- Lifecycle ----------------------------------------------------------------------

    pub fn start(
        &self,
        path: Option<&Value>,
        name: Option<&Value>,
        pin: Option<&Value>,
        excluded: Option<&Value>,
    ) -> AppResult<Value> {
        if let Some(share) = self.current_share() {
            return Err(AppError::conflict(
                format!("Already hosting \"{}\". Stop hosting first.", share.name),
                "already_hosting",
            ));
        }
        let check = check_host_directory(path.and_then(Value::as_str));
        if !check.ok {
            return Err(AppError::bad_request(check.message, "invalid_path"));
        }
        let root = PathBuf::from(check.path.unwrap_or_default());
        let pin_value = if pin_missing(pin) { generate_pin() } else { assert_pin(pin)? };
        let mut selection = Selection::from_input(excluded)?;
        let trimmed: String =
            name.and_then(Value::as_str).map(str::trim).unwrap_or("").chars().take(MAX_NAME_LENGTH).collect();
        let display_name = if !trimmed.trim().is_empty() {
            trimmed.trim().to_string()
        } else {
            root.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| root.to_string_lossy().into_owned())
        };

        for excluded_path in selection.list() {
            let state = resolve(&root, &excluded_path).ok().and_then(|p| read_state_lossy(&p));
            selection.bind_identity(&excluded_path, state.and_then(|s| s.id));
        }
        remove_stale_temp_files(&root);

        let share = Arc::new(Share {
            id: new_uuid(),
            name: display_name.clone(),
            root: root.clone(),
            started_at: now_ms(),
            disk: Mutex::new(ShareDisk {
                index: FileIndex::new(),
                selection,
                stats: None,
                stats_at: 0,
                stats_dirty: true,
            }),
            session: Mutex::new(None),
            pin: Mutex::new(pin_value),
            error: Mutex::new(None),
            watcher: Mutex::new(None),
            stopped: AtomicBool::new(false),
            service: self.myself.clone(),
        });

        let watcher = Watcher::start(
            &root,
            share.clone() as Arc<dyn WatchOwner>,
            self.watcher_timing,
            self.logger.child("watch"),
        )
        .map_err(|error| AppError::bad_request(format!("Cannot watch {}: {error}", root.display()), "invalid_path"))?;
        {
            let mut disk = share.disk.locked();
            let selection = disk.selection.clone();
            let filter = |wire: &str, _: &State| {
                if selection.has_excluded_ancestor(wire) {
                    Decision::Prune
                } else {
                    Decision::Include
                }
            };
            match walk_tree(&root, WalkOptions { filter: Some(&filter), ..Default::default() }) {
                Ok(walk) => disk.index.replace_all(walk.entries),
                Err(error) => {
                    drop(disk);
                    watcher.close();
                    return Err(AppError::bad_request(error.to_string(), "invalid_path"));
                }
            }
        }
        *share.watcher.locked() = Some(watcher);

        *self.current.locked() = Some(share.clone());
        self.active.store(true, Ordering::SeqCst);
        *self.notice.locked() = None;
        self.activity.clear();
        self.activity.add(Entry::info(format!("Hosting \"{display_name}\" from {}.", share.root_text())));
        self.bus.emit(Event::HostingStarted { name: display_name, path: share.root_text(), id: share.id.clone() });
        self.changed();
        Ok(self.status())
    }

    pub fn stop(&self, reason: &str) {
        let Some(share) = self.current.locked().take() else { return };
        self.active.store(false, Ordering::SeqCst);
        share.stopped.store(true, Ordering::SeqCst);
        self.end_session(&share, bye::HOST_STOPPED, &format!("The host stopped hosting \"{}\".", share.name));
        let watcher = share.watcher.locked().take();
        if let Some(watcher) = watcher {
            watcher.close();
        }
        if reason == "root_missing" {
            *self.notice.locked() = Some(
                json!({ "kind": "error", "message": format!("Hosting stopped: the directory {} disappeared.", share.root_text()) }),
            );
        }
        self.activity.add(Entry::info(format!("Stopped hosting \"{}\".", share.name)));
        self.bus.emit(Event::HostingStopped {
            name: share.name.clone(),
            id: share.id.clone(),
            reason: reason.to_string(),
        });
        self.changed();
    }

    pub fn set_pin(&self, pin: Option<&Value>) -> AppResult<Value> {
        let share = self.require_share()?;
        let random = pin_missing(pin);
        let mut value = if random { generate_pin() } else { assert_pin(pin)? };
        {
            let current = share.pin.locked();
            if random {
                // A "random" PIN must actually be different.
                while value == *current {
                    value = generate_pin();
                }
            }
            if value == *current {
                return Ok(json!({ "pin": value, "changed": false, "disconnected": false }));
            }
        }
        *share.pin.locked() = value.clone();
        let had_peer = share.session.locked().is_some();
        self.activity.add(Entry::info("The PIN was changed."));
        // The specification: a PIN change cuts the connected instance off at once.
        self.end_session(&share, bye::PIN_CHANGED, "The host changed the PIN. Enter the new PIN to resume.");
        self.bus.emit(Event::HostingPinChanged { disconnected: had_peer });
        self.changed();
        Ok(json!({ "pin": value, "changed": true, "disconnected": had_peer }))
    }

    pub fn status(&self) -> Value {
        let Some(share) = self.current_share() else {
            return match self.notice.locked().clone() {
                Some(notice) => json!({ "active": false, "notice": notice }),
                None => Value::Null,
            };
        };
        let (excluded, stats) = {
            let mut disk = share.disk.locked();
            (disk.selection.list(), HostingService::compute_stats(&mut disk))
        };
        let session = share.session.locked().as_ref().map(Session::public).unwrap_or(Value::Null);
        json!({
            "active": true,
            "id": share.id,
            "name": share.name,
            "path": share.root_text(),
            "pin": *share.pin.locked(),
            "startedAt": share.started_at,
            "excluded": excluded,
            "stats": stats,
            "session": session,
            "error": *share.error.locked(),
            "activity": self.activity.recent(60),
        })
    }

    /// What `GET /api/ping` says about hosting.
    pub fn ping_info(&self) -> Value {
        match self.current_share() {
            Some(share) => {
                let connected = share.session.locked().is_some();
                json!({ "id": share.id, "name": share.name, "connected": connected })
            }
            None => Value::Null,
        }
    }

    // --- Peer API ------------------------------------------------------------------------

    /// A peer asks to connect.
    pub fn connect(
        &self,
        pin: Option<&Value>,
        protocol: Option<&Value>,
        peer: Option<&Value>,
        remote_address: &str,
    ) -> AppResult<Value> {
        let share = self.require_share()?;
        if let Some(protocol) = protocol.and_then(Value::as_str).filter(|p| !p.is_empty()) {
            if protocol != self.identity.protocol {
                return Err(AppError::bad_request(
                    format!(
                        "Protocol mismatch: this instance uses {} and yours uses {}. Both must use the same protocol.",
                        self.identity.protocol.to_uppercase(),
                        protocol.to_uppercase()
                    ),
                    "protocol_mismatch",
                ));
            }
        }
        let info = peer.filter(|p| p.is_object());
        let field = |name: &str| info.and_then(|i| i.get(name)).and_then(Value::as_str);
        let uuid: String = field("uuid").unwrap_or("").chars().take(64).collect();
        if uuid.is_empty() {
            return Err(AppError::bad_request("The connecting instance did not identify itself.", "bad_request"));
        }
        let hostname: String =
            field("hostname").filter(|h| !h.is_empty()).unwrap_or("unknown").chars().take(255).collect();

        let replacing = {
            let session = share.session.locked();
            match session.as_ref() {
                // One peer at a time, whatever PIN it brings.
                Some(current) if current.peer.uuid != uuid => {
                    return Err(AppError::conflict(
                        format!(
                            "\"{}\" is already being synced by {} ({}). A hosted directory accepts only one connected instance at a time.",
                            share.name, current.peer.hostname, current.peer.address
                        ),
                        "busy",
                    )
                    .with_details(json!({ "hostname": current.peer.hostname, "address": current.peer.address })));
                }
                Some(_) => true,
                None => false,
            }
        };
        let candidate = pin.and_then(Value::as_str).map(str::trim).unwrap_or("");
        if !pin_matches(candidate, &share.pin.locked()) {
            return Err(AppError::forbidden("Wrong PIN.", "pin_invalid"));
        }
        if let (Some(machine), Some(local_path)) = (field("machine"), field("localPath")) {
            if machine == self.identity.machine && paths_overlap(local_path, &share.root_text()) {
                return Err(AppError::bad_request(
                    "That local directory is the hosted directory itself, or is inside it, or contains it. Choose another directory.",
                    "same_directory",
                ));
            }
        }
        // The same peer reconnecting replaces its previous session.
        if replacing {
            self.end_session(&share, bye::REPLACED, "A newer connection from the same instance replaced this one.");
        }

        let now = now_ms();
        let token = new_token();
        let address = if remote_address.is_empty() { "unknown".to_string() } else { remote_address.to_string() };
        let heartbeat = self.start_heartbeat(&share, &token);
        let session = Session {
            token: token.clone(),
            peer: PeerInfo { uuid, hostname: hostname.clone(), address: address.clone() },
            since: now,
            last_seen: now,
            phase: "connecting".into(),
            progress: Value::Null,
            sink: None,
            heartbeat,
        };
        let peer_json = session.peer_json();
        *share.session.locked() = Some(session);

        self.activity.add(Entry::info(format!("{hostname} ({address}) connected.")));
        self.bus.emit(Event::HostingPeerConnected { peer: peer_json });
        self.changed();
        Ok(json!({
            "token": token,
            "protocolVersion": PROTOCOL_VERSION,
            "share": { "id": share.id, "name": share.name },
            "host": { "uuid": self.identity.uuid, "hostname": self.identity.hostname },
        }))
    }

    /// Drop a peer that went silent; keep its stream busy otherwise.
    fn start_heartbeat(&self, share: &Arc<Share>, token: &str) -> Arc<Sleeper> {
        let weak_share = Arc::downgrade(share);
        let service = self.myself.clone();
        let token = token.to_string();
        let silence = self.timing.peer_silence_ms as i64;
        every("host-heartbeat", Duration::from_millis(self.timing.stream_heartbeat_ms), move || {
            let (Some(share), Some(service)) = (weak_share.upgrade(), service.upgrade()) else { return };
            let timed_out = {
                let session = share.session.locked();
                match session.as_ref() {
                    Some(session) if session.token == token => {
                        if now_ms() - session.last_seen > silence {
                            true
                        } else {
                            if let Some(sink) = &session.sink {
                                sink.send(&json!({ "type": stream::HEARTBEAT, "at": now_ms() }));
                            }
                            false
                        }
                    }
                    _ => return,
                }
            };
            if timed_out {
                service.end_session(&share, bye::TIMEOUT, "The host stopped hearing from this instance.");
            }
        })
    }

    /// Attach the NDJSON stream of an authorised session. Returns the share,
    /// for `detach_stream` when the connection ends.
    pub fn attach_stream(&self, token: &str, sink: Arc<Sink>) -> AppResult<Arc<Share>> {
        let share = self.authorize(token)?;
        {
            let mut guard = share.session.locked();
            let Some(session) = guard.as_mut() else { return Err(AppError::unauthorized()) };
            if let Some(previous) = session.sink.take() {
                if !Arc::ptr_eq(&previous, &sink) {
                    previous.close();
                }
            }
            session.sink = Some(sink.clone());
            session.phase = "syncing".into();
        }
        sink.send(&json!({
            "type": stream::HELLO,
            "protocolVersion": PROTOCOL_VERSION,
            "share": { "id": share.id, "name": share.name },
            "host": { "uuid": self.identity.uuid, "hostname": self.identity.hostname },
        }));
        self.changed();
        Ok(share)
    }

    /// The stream's connection ended.
    pub fn detach_stream(&self, share: &Share, sink: &Arc<Sink>) {
        let mut changed = false;
        if let Some(session) = share.session.locked().as_mut() {
            if session.sink.as_ref().map(|s| Arc::ptr_eq(s, sink)).unwrap_or(false) {
                session.sink = None;
                changed = true;
            }
        }
        if changed {
            self.changed();
        }
    }

    /// Every shared entry, freshly read from disk.
    pub fn manifest(&self, token: &str) -> AppResult<Value> {
        let share = self.authorize(token)?;
        let selection = share.selection();
        let filter =
            |wire: &str, _: &State| if selection.is_excluded(wire) { Decision::Prune } else { Decision::Include };
        let walk = walk_tree(&share.root, WalkOptions { filter: Some(&filter), ..Default::default() })
            .map_err(|error| AppError::new("internal", error.to_string(), 500))?;
        let entries: Vec<Value> = walk
            .entries
            .iter()
            .map(|(path, state)| {
                json!({ "path": path, "kind": state.kind.as_str(), "size": state.public().size, "mtimeMs": state.mtime_ms })
            })
            .collect();
        Ok(json!({ "share": { "id": share.id, "name": share.name }, "entries": entries }))
    }

    pub fn hashes(&self, token: &str, paths: Option<&Value>) -> AppResult<Value> {
        let share = self.authorize(token)?;
        let list = match paths {
            Some(Value::Array(list)) if list.len() <= 20_000 => list,
            _ => return Err(AppError::bad_request("Expected a list of up to 20000 paths.", "bad_request")),
        };
        let selection = share.selection();
        let mut out = Map::new();
        for raw in list {
            let Some(path) = raw.as_str().and_then(|text| normalize(text, false)) else { continue };
            if selection.is_excluded(&path) {
                continue;
            }
            // Skipped on any error: the peer treats a missing hash as "different".
            let Ok(absolute) = resolve_safely(&share.root, &path) else { continue };
            if read_state_lossy(&absolute).map(|s| s.kind) == Some(Kind::File) {
                if let Ok(hash) = hash_file(&absolute) {
                    out.insert(path, json!(hash));
                }
            }
        }
        Ok(json!({ "hashes": out }))
    }

    /// Resolve a file the peer wants to download.
    pub fn open_file(&self, token: &str, raw_path: Option<&Value>) -> AppResult<OpenedFile> {
        let share = self.authorize(token)?;
        let path = shared_path(&share.selection(), raw_path)?;
        let absolute = resolve_safely(&share.root, &path).map_err(from_fs)?;
        match read_state_lossy(&absolute) {
            Some(state) if state.kind == Kind::File => Ok(OpenedFile { share, path, absolute, state }),
            _ => Err(AppError::not_found(format!("\"{path}\" is not a file on the host."))),
        }
    }

    /// The route sent a whole file.
    pub fn file_sent(&self, file: &OpenedFile) {
        self.activity.add(Entry::op("sent", "write", &file.path).with_size(file.state.size));
    }

    /// Decide whether an upload is accepted, before its body is read.
    pub fn prepare_upload(
        &self,
        token: &str,
        raw_path: Option<&Value>,
        size: f64,
        mtime_ms: f64,
        base: Option<State>,
    ) -> AppResult<PreparedUpload> {
        let share = self.authorize(token)?;
        let path = shared_path(&share.selection(), raw_path)?;
        if !size.is_finite() || size < 0.0 {
            return Err(AppError::bad_request("Missing or invalid file size.", "bad_request"));
        }
        if !mtime_ms.is_finite() || mtime_ms <= 0.0 {
            return Err(AppError::bad_request("Missing or invalid modification time.", "bad_request"));
        }
        let absolute = resolve_safely(&share.root, &path).map_err(from_fs)?;
        let existing = read_state_lossy(&absolute);
        if let Some(existing) = existing {
            if existing.kind != Kind::File {
                return Err(AppError::conflict(format!("\"{path}\" is a directory on the host."), "conflict"));
            }
        }
        let incoming = State::file(size as u64, mtime_ms as i64);
        if let Some(existing) = existing {
            if same_state(Some(&existing), Some(&incoming)) {
                return Ok(PreparedUpload { share, path, absolute, existing: Some(existing), unchanged: true });
            }
            if !base.map(|b| same_state(Some(&existing), Some(&b))).unwrap_or(false)
                && existing.mtime_ms as f64 >= mtime_ms
            {
                // Both sides changed the file: the newer version wins, and it is the host's.
                return Err(AppError::conflict(format!("The host has a newer version of \"{path}\"."), "conflict"));
            }
        }
        Ok(PreparedUpload { share, path, absolute, existing, unchanged: false })
    }

    /// Receive an upload whose metadata `prepare_upload` accepted.
    pub fn receive_file(
        &self,
        prepared: PreparedUpload,
        body: &mut dyn Read,
        size: u64,
        mtime_ms: i64,
    ) -> AppResult<Value> {
        let PreparedUpload { share, path, absolute, existing, .. } = prepared;
        if share.stopped.load(Ordering::SeqCst) {
            return Err(AppError::conflict("Hosting stopped during the transfer.", "not_hosting"));
        }
        {
            let mut disk = share.disk.locked();
            for (created, state) in ensure_directory(&share.root, parent_of(&path)).map_err(from_fs)? {
                disk.index.set(&created, state);
            }
        }
        let staged = stage_file(&share.root, &path, body, Some(size), mtime_ms).map_err(from_fs)?;
        let committed = (|| -> AppResult<()> {
            let mut disk = share.disk.locked();
            // The host's own copy may have changed while the bytes were travelling.
            let now = read_state(&absolute).map_err(|e| crate::domain::errors::from_io(&e))?;
            if let Some(now) = now {
                if now.kind != Kind::File {
                    return Err(AppError::conflict(format!("\"{path}\" is a directory on the host."), "conflict"));
                }
                if !existing.map(|e| same_state(Some(&now), Some(&e))).unwrap_or(false) && now.mtime_ms >= mtime_ms {
                    return Err(AppError::conflict(
                        format!("\"{path}\" changed on the host during the transfer."),
                        "conflict",
                    ));
                }
            }
            disk.index.set(&path, staged.state);
            staged.commit().map_err(from_fs)?;
            disk.stats_dirty = true;
            Ok(())
        })();
        if let Err(error) = committed {
            staged.discard();
            return Err(error);
        }
        self.activity.add(Entry::op("received", "write", &path).with_size(size));
        Ok(json!({ "ok": true, "state": staged.state.to_json() }))
    }

    /// Apply one non-content operation from the peer, under the disk lock.
    fn apply_one(&self, share: &Share, disk: &mut ShareDisk, op: &Value) -> AppResult<Value> {
        let root = &share.root;
        let name = op.get("op").and_then(Value::as_str).unwrap_or("");
        match name {
            "mkdir" => {
                let path = shared_path(&disk.selection, op.get("path"))?;
                let created = ensure_directory(root, &path).map_err(from_fs)?;
                for (wire, state) in &created {
                    disk.index.set(wire, *state);
                }
                if !created.is_empty() {
                    self.activity.add(Entry::op("received", "mkdir", &path));
                }
                Ok(json!({ "ok": true }))
            }
            "unlink" => {
                let path = shared_path(&disk.selection, op.get("path"))?;
                let absolute = resolve_safely(root, &path).map_err(from_fs)?;
                let Some(existing) = read_state_lossy(&absolute) else {
                    disk.index.delete(&path);
                    return Ok(json!({ "ok": true, "missing": true }));
                };
                if existing.kind != Kind::File {
                    return Err(AppError::conflict(format!("\"{path}\" is not a file on the host."), "conflict"));
                }
                if let Some(base) = base_of(op) {
                    if !same_state(Some(&existing), Some(&base)) {
                        return Err(AppError::conflict(
                            format!("\"{path}\" was modified on the host, and a modification wins over a deletion."),
                            "conflict",
                        ));
                    }
                }
                disk.index.delete(&path);
                remove_file(root, &path).map_err(from_fs)?;
                self.activity.add(Entry::op("received", "unlink", &path));
                Ok(json!({ "ok": true }))
            }
            "rmdir" => {
                let path = shared_path(&disk.selection, op.get("path"))?;
                let absolute = resolve_safely(root, &path).map_err(from_fs)?;
                let Some(existing) = read_state_lossy(&absolute) else {
                    disk.index.delete_tree(&path);
                    return Ok(json!({ "ok": true, "missing": true }));
                };
                if existing.kind != Kind::Dir {
                    return Err(AppError::conflict(format!("\"{path}\" is not a directory on the host."), "conflict"));
                }
                let (removed, kept) = {
                    let (selection, index) = (&disk.selection, &disk.index);
                    // Unchecked content stays; so does anything changed since the
                    // host last announced it (it will reach the peer by the stream).
                    remove_tree(root, &path, &mut |wire, state| {
                        !selection.is_excluded(wire)
                            && (state.kind == Kind::Dir || same_state(Some(state), index.get(wire)))
                    })
                    .map_err(from_fs)?
                };
                for wire in &removed {
                    disk.index.delete(wire);
                }
                self.activity.add(Entry::op("received", "rmdir", &path));
                Ok(if kept.is_empty() { json!({ "ok": true }) } else { json!({ "ok": true, "partial": true }) })
            }
            "rename" => {
                let from = shared_path(&disk.selection, op.get("from"))?;
                let to = shared_path(&disk.selection, op.get("to"))?;
                if from == to || is_strictly_inside(&from, &to) {
                    return Err(AppError::bad_request("Invalid rename.", "bad_path"));
                }
                let source = read_state_lossy(&resolve_safely(root, &from).map_err(from_fs)?);
                let Some(source) = source else {
                    return Err(AppError::conflict(format!("\"{from}\" no longer exists on the host."), "conflict"));
                };
                let target = read_state_lossy(&resolve_safely(root, &to).map_err(from_fs)?);
                if let Some(target) = target {
                    if target.kind == Kind::Dir || source.kind == Kind::Dir {
                        return Err(AppError::conflict(format!("\"{to}\" already exists on the host."), "conflict"));
                    }
                }
                if source.kind == Kind::File {
                    if let Some(base) = base_of(op) {
                        if !same_state(Some(&source), Some(&base)) {
                            return Err(AppError::conflict(
                                format!("\"{from}\" was modified on the host before the rename arrived."),
                                "conflict",
                            ));
                        }
                    }
                }
                if source.kind == Kind::Dir && disk.selection.has_exclusions_inside(&from) {
                    // Unchecked items inside must not move: move everything else.
                    let selection = disk.selection.clone();
                    let (moved, kept) = move_tree_selective(root, &from, &to, &|wire, _| !selection.is_excluded(wire))
                        .map_err(from_fs)?;
                    for (a, b) in &moved {
                        disk.index.rekey(a, b);
                    }
                    let to_path = resolve_safely(root, &to).map_err(from_fs)?;
                    for (relative, state) in walk_all(&to_path).unwrap_or_default() {
                        let wire = format!("{to}/{relative}");
                        if !disk.index.has(&wire) {
                            disk.index.set(&wire, state);
                        }
                    }
                    if let Some(state) = read_state_lossy(&to_path) {
                        disk.index.set(&to, state);
                    }
                    // Directories emptied and removed by the move must leave the
                    // index too, or the watcher would announce their removal.
                    let mut gone: Vec<String> = disk.index.descendants(&from).into_iter().map(|(p, _)| p).collect();
                    gone.push(from.clone());
                    for wire in gone {
                        if resolve(root, &wire).ok().and_then(|p| read_state_lossy(&p)).is_none() {
                            disk.index.delete(&wire);
                        }
                    }
                    self.activity.add(Entry::op("received", "rename", &from).with_to(Some(&to)));
                    return Ok(if kept.is_empty() {
                        json!({ "ok": true })
                    } else {
                        json!({ "ok": true, "partial": true })
                    });
                }
                for (wire, state) in ensure_directory(root, parent_of(&to)).map_err(from_fs)? {
                    disk.index.set(&wire, state);
                }
                disk.index.rekey(&from, &to);
                if let Err(error) = move_entry(root, &from, &to) {
                    disk.index.rekey(&to, &from);
                    return Err(from_fs(error));
                }
                self.activity.add(Entry::op("received", "rename", &from).with_to(Some(&to)));
                Ok(json!({ "ok": true }))
            }
            other => {
                let shown = op.get("op").map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()));
                let _ = other;
                Err(AppError::bad_request(
                    format!("Unknown operation: {}", shown.unwrap_or_else(|| "undefined".into())),
                    "bad_op",
                ))
            }
        }
    }

    /// Apply a list of operations in order; each gets its own result.
    pub fn apply_ops(&self, token: &str, ops: Option<&Value>) -> AppResult<Value> {
        let share = self.authorize(token)?;
        let list = match ops {
            Some(Value::Array(list)) if list.len() <= 50_000 => list,
            _ => return Err(AppError::bad_request("Expected a list of operations.", "bad_request")),
        };
        let mut results = Vec::with_capacity(list.len());
        for op in list {
            let still_current = self.current_share().map(|current| Arc::ptr_eq(&current, &share)).unwrap_or(false);
            if !still_current {
                results.push(json!({ "ok": false, "code": "not_hosting", "message": "Hosting stopped." }));
                continue;
            }
            let mut disk = share.disk.locked();
            match self.apply_one(&share, &mut disk, op) {
                Ok(result) => results.push(result),
                Err(error) => {
                    if error.status >= 500 {
                        self.logger.error(format_args!("applying a peer operation failed: {}", error.message));
                    }
                    results.push(json!({ "ok": false, "code": error.code, "message": error.message }));
                }
            }
            disk.stats_dirty = true;
        }
        self.changed();
        Ok(json!({ "results": results }))
    }

    pub fn heartbeat(&self, token: &str, report: &Value) -> AppResult<Value> {
        let share = self.authorize(token)?;
        let changed = {
            let mut guard = share.session.locked();
            let Some(session) = guard.as_mut() else { return Err(AppError::unauthorized()) };
            let phase = match report.get("phase").and_then(Value::as_str) {
                Some(phase @ ("live" | "syncing")) => phase.to_string(),
                _ => session.phase.clone(),
            };
            let progress = report.get("progress").filter(|p| p.is_object()).cloned().unwrap_or(Value::Null);
            let changed = phase != session.phase || progress != session.progress;
            session.phase = phase;
            session.progress = progress;
            changed
        };
        if changed {
            self.changed();
        }
        Ok(json!({ "ok": true }))
    }

    pub fn disconnect(&self, token: &str) -> AppResult<Value> {
        let share = self.authorize(token)?;
        self.end_session(&share, "left", "Disconnected.");
        Ok(json!({ "ok": true }))
    }

    /// Wait until pending watcher batches are processed (tests).
    pub fn settle(&self) {
        if let Some(share) = self.current_share() {
            if let Some(watcher) = share.watcher.locked().as_ref() {
                watcher.flush();
            }
        }
    }

    /// The hosted root, for tests and diagnostics.
    pub fn root(&self) -> Option<PathBuf> {
        self.current_share().map(|share| share.root.clone())
    }

    #[doc(hidden)]
    pub fn root_path_text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
}
