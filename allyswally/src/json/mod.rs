//! A hand-written JSON value type, parser and serializer.
//!
//! JSON is the app's one data format: config, the MASKED items, the export
//! bundle, WebSocket messages and the log lines all flow through here. There
//! is no `serde`; this module is the whole implementation.
//!
//! Object keys keep insertion order (`Vec<(String, Value)>`), so files the app
//! writes stay stable and diff cleanly, and a human editing them by hand sees
//! their keys in the order the app laid them out. The parser reports the line
//! and column of an error, which Diagnostics surfaces for hand-edited files.

mod parser;
mod ser;

pub use parser::parse;
// Part of the json module's public surface (the error type `parse` returns);
// referenced structurally rather than by name within the crate.
#[allow(unused_imports)]
pub use parser::ParseError;

use std::collections::BTreeMap;

/// A JSON value. Numbers are stored as `f64`, matching JSON's single numeric
/// type; integer accessors round-trip exact values within the `f64` range.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}

impl Value {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Num(n) => Some(*n as i64),
            _ => None,
        }
    }

    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Value::Num(n) if *n >= 0.0 => Some(*n as u64),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, Value)]> {
        match self {
            Value::Object(o) => Some(o),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// Look up a key in an object value, if this is an object.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// A borrowed string if the key holds a string, else `None`.
    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(|v| v.as_str())
    }

    pub fn get_bool(&self, key: &str) -> Option<bool> {
        self.get(key).and_then(|v| v.as_bool())
    }

    pub fn get_f64(&self, key: &str) -> Option<f64> {
        self.get(key).and_then(|v| v.as_f64())
    }

    pub fn get_i64(&self, key: &str) -> Option<i64> {
        self.get(key).and_then(|v| v.as_i64())
    }

    /// Compact serialization (no spaces), for the wire and the log.
    pub fn to_string(&self) -> String {
        ser::to_string(self, false)
    }

    /// Indented serialization (two spaces), for files a person edits.
    pub fn to_pretty(&self) -> String {
        ser::to_string(self, true)
    }
}

/// Build an object `Value` from an iterator of pairs, preserving order.
pub fn object(pairs: Vec<(String, Value)>) -> Value {
    Value::Object(pairs)
}

/// Convenience: a `Value::Str` from anything string-like.
pub fn s(v: impl Into<String>) -> Value {
    Value::Str(v.into())
}

/// Convenience: a `Value::Num` from an integer.
pub fn n(v: impl Into<f64>) -> Value {
    Value::Num(v.into())
}

/// A small builder that keeps object construction readable at call sites and
/// guarantees stable key order.
#[derive(Default)]
pub struct Obj(pub Vec<(String, Value)>);

impl Obj {
    pub fn new() -> Obj {
        Obj(Vec::new())
    }
    pub fn set(mut self, key: &str, value: Value) -> Obj {
        self.0.push((key.to_string(), value));
        self
    }
    pub fn str(self, key: &str, value: impl Into<String>) -> Obj {
        self.set(key, Value::Str(value.into()))
    }
    pub fn num(self, key: &str, value: impl Into<f64>) -> Obj {
        self.set(key, Value::Num(value.into()))
    }
    pub fn boolean(self, key: &str, value: bool) -> Obj {
        self.set(key, Value::Bool(value))
    }
    pub fn build(self) -> Value {
        Value::Object(self.0)
    }
}

/// Merge `incoming` into `base` recursively: objects are merged key by key,
/// and every other kind (including arrays) replaces wholesale. Used by the
/// "combine" mode of config import.
pub fn merge(base: &mut Value, incoming: &Value) {
    if let (Value::Object(b), Value::Object(i)) = (&mut *base, incoming) {
        // Map each existing key to its slot, cloning the key so the index does
        // not borrow `b` while we mutate it below.
        let mut index: BTreeMap<String, usize> = BTreeMap::new();
        for (idx, (k, _)) in b.iter().enumerate() {
            index.insert(k.clone(), idx);
        }
        for (k, v) in i {
            if let Some(&idx) = index.get(k) {
                merge(&mut b[idx].1, v);
            } else {
                index.insert(k.clone(), b.len());
                b.push((k.clone(), v.clone()));
            }
        }
    } else {
        *base = incoming.clone();
    }
}
