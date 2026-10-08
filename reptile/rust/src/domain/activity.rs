//! A bounded, in-memory log of what the current session did: files sent and
//! received, connections, warnings. The interface shows the most recent
//! entries so that both sides can see synchronisation happening. Nothing is
//! written to disk.

use crate::util::events::{Event, EventBus};
use crate::util::threads::Locked;
use crate::util::time::now_ms;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

/// One entry; absent fields are left out of the JSON, like `undefined`.
#[derive(Default, Clone)]
pub struct Entry {
    /// sent | received | info | warning | error
    pub kind: &'static str,
    pub op: Option<String>,
    pub path: Option<String>,
    pub to: Option<String>,
    pub size: Option<u64>,
    pub message: Option<String>,
}

impl Entry {
    pub fn info(message: impl Into<String>) -> Entry {
        Entry { kind: "info", message: Some(message.into()), ..Default::default() }
    }

    pub fn warning(message: impl Into<String>) -> Entry {
        Entry { kind: "warning", message: Some(message.into()), ..Default::default() }
    }

    pub fn error(message: impl Into<String>) -> Entry {
        Entry { kind: "error", message: Some(message.into()), ..Default::default() }
    }

    /// A transfer or an operation: `kind` is "sent" or "received".
    pub fn op(kind: &'static str, op: &str, path: &str) -> Entry {
        Entry { kind, op: Some(op.to_string()), path: Some(path.to_string()), ..Default::default() }
    }

    pub fn with_to(mut self, to: Option<&str>) -> Entry {
        self.to = to.map(str::to_string);
        self
    }

    pub fn with_size(mut self, size: u64) -> Entry {
        self.size = Some(size);
        self
    }

    pub fn with_path(mut self, path: &str) -> Entry {
        self.path = Some(path.to_string());
        self
    }
}

struct State {
    entries: VecDeque<Value>,
    next_id: u64,
}

pub struct ActivityLog {
    bus: Arc<EventBus>,
    limit: usize,
    source: &'static str,
    state: Mutex<State>,
}

impl ActivityLog {
    pub fn new(bus: Arc<EventBus>, source: &'static str) -> ActivityLog {
        ActivityLog { bus, limit: 200, source, state: Mutex::new(State { entries: VecDeque::new(), next_id: 1 }) }
    }

    pub fn add(&self, entry: Entry) -> Value {
        let record = {
            let mut state = self.state.locked();
            let mut object = Map::new();
            object.insert("id".into(), json!(state.next_id));
            object.insert("at".into(), json!(now_ms()));
            object.insert("kind".into(), json!(entry.kind));
            if let Some(op) = entry.op {
                object.insert("op".into(), json!(op));
            }
            if let Some(path) = entry.path {
                object.insert("path".into(), json!(path));
            }
            if let Some(to) = entry.to {
                object.insert("to".into(), json!(to));
            }
            if let Some(size) = entry.size {
                object.insert("size".into(), json!(size));
            }
            if let Some(message) = entry.message {
                object.insert("message".into(), json!(message));
            }
            state.next_id += 1;
            let record = Value::Object(object);
            state.entries.push_back(record.clone());
            while state.entries.len() > self.limit {
                state.entries.pop_front();
            }
            record
        };
        self.bus.emit(Event::Activity { source: self.source, entry: record.clone() });
        self.bus.changed(self.source);
        record
    }

    /// Most recent first.
    pub fn recent(&self, count: usize) -> Vec<Value> {
        self.state.locked().entries.iter().rev().take(count).cloned().collect()
    }

    pub fn clear(&self) {
        self.state.locked().entries.clear();
        self.bus.changed(self.source);
    }
}
