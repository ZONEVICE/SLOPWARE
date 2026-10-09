//! Helpers for the MASKED item model shared by all four categories.
//!
//! Every item is a JSON object with a stable random `id`, a `name`,
//! `description`, `showInBand`, `order`, optional `color`/`icon`, `createdAt`
//! and `updatedAt`, plus its category-specific fields. The server owns `id` and
//! the timestamps; the client owns everything else. These helpers operate on
//! the category's JSON array in place.

use crate::json::Value;
use crate::win::crypto::random_bytes;
use std::time::{SystemTime, UNIX_EPOCH};

/// A fresh 48-bit random id, hex-encoded (12 chars) — short but collision-safe
/// for the handful of items a user creates.
pub fn new_id() -> String {
    random_bytes(6).iter().map(|b| format!("{b:02x}")).collect()
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The array of items for a category value (empty if it is not an array).
fn as_items(value: &Value) -> Vec<Value> {
    value.as_array().map(|a| a.to_vec()).unwrap_or_default()
}

/// Insert or update `item` within `list`, returning the new array and the id.
/// A missing or empty id means "create": the server assigns an id, `createdAt`
/// and an `order` after the current maximum. An existing id updates in place,
/// preserving `createdAt` and bumping `updatedAt`.
pub fn upsert(list: &Value, mut item: Vec<(String, Value)>) -> (Value, String) {
    let mut items = as_items(list);
    let now = now_unix();

    // Pull the incoming id, if any.
    let incoming_id = item
        .iter()
        .find(|(k, _)| k == "id")
        .and_then(|(_, v)| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let existing_index = incoming_id
        .as_ref()
        .and_then(|id| items.iter().position(|it| it.get_str("id") == Some(id)));

    // Ensure defaults for optional fields.
    ensure_default(&mut item, "showInBand", Value::Bool(false));
    ensure_default(&mut item, "description", Value::Str(String::new()));

    match existing_index {
        Some(idx) => {
            let id = incoming_id.unwrap();
            let created = items[idx].get_i64("createdAt").unwrap_or(now);
            let order = items[idx].get_i64("order").unwrap_or(0);
            set_field(&mut item, "id", Value::Str(id.clone()));
            set_field(&mut item, "createdAt", Value::Num(created as f64));
            set_field(&mut item, "updatedAt", Value::Num(now as f64));
            if !has_field(&item, "order") {
                set_field(&mut item, "order", Value::Num(order as f64));
            }
            items[idx] = Value::Object(item);
            (Value::Array(items), id)
        }
        None => {
            let id = new_id();
            let next_order = items
                .iter()
                .filter_map(|it| it.get_i64("order"))
                .max()
                .unwrap_or(-1)
                + 1;
            set_field(&mut item, "id", Value::Str(id.clone()));
            set_field(&mut item, "createdAt", Value::Num(now as f64));
            set_field(&mut item, "updatedAt", Value::Num(now as f64));
            if !has_field(&item, "order") {
                set_field(&mut item, "order", Value::Num(next_order as f64));
            }
            items.push(Value::Object(item));
            (Value::Array(items), id)
        }
    }
}

/// Remove the item with `id`. Returns the new array and whether anything was
/// removed.
pub fn remove(list: &Value, id: &str) -> (Value, bool) {
    let mut items = as_items(list);
    let before = items.len();
    items.retain(|it| it.get_str("id") != Some(id));
    let removed = items.len() != before;
    (Value::Array(items), removed)
}

/// Reorder a category so its items follow `ids`; ids not present are ignored,
/// and items missing from `ids` keep their relative order at the end. The
/// `order` field is rewritten to the new index.
pub fn reorder(list: &Value, ids: &[String]) -> Value {
    let items = as_items(list);
    let mut out: Vec<Value> = Vec::with_capacity(items.len());
    for id in ids {
        if let Some(it) = items.iter().find(|it| it.get_str("id") == Some(id)) {
            out.push(it.clone());
        }
    }
    for it in &items {
        let id = it.get_str("id").unwrap_or("");
        if !ids.iter().any(|x| x == id) {
            out.push(it.clone());
        }
    }
    for (i, it) in out.iter_mut().enumerate() {
        if let Value::Object(pairs) = it {
            set_field(pairs, "order", Value::Num(i as f64));
        }
    }
    Value::Array(out)
}

/// Find an item by id across a single category list.
pub fn find<'a>(list: &'a Value, id: &str) -> Option<&'a Value> {
    list.as_array()?.iter().find(|it| it.get_str("id") == Some(id))
}

// --- small object helpers --------------------------------------------------

fn has_field(pairs: &[(String, Value)], key: &str) -> bool {
    pairs.iter().any(|(k, _)| k == key)
}

fn set_field(pairs: &mut Vec<(String, Value)>, key: &str, value: Value) {
    if let Some(slot) = pairs.iter_mut().find(|(k, _)| k == key) {
        slot.1 = value;
    } else {
        pairs.push((key.to_string(), value));
    }
}

fn ensure_default(pairs: &mut Vec<(String, Value)>, key: &str, value: Value) {
    if !has_field(pairs, key) {
        pairs.push((key.to_string(), value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::Obj;

    fn obj(pairs: Vec<(&str, Value)>) -> Vec<(String, Value)> {
        pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }

    #[test]
    fn create_assigns_id_and_order() {
        let list = Value::Array(vec![]);
        let (list, id) = upsert(&list, obj(vec![("name", Value::Str("Copy".into()))]));
        assert!(!id.is_empty());
        let items = list.as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].get_str("id"), Some(id.as_str()));
        assert_eq!(items[0].get_i64("order"), Some(0));
        assert!(items[0].get_i64("createdAt").is_some());
    }

    #[test]
    fn update_preserves_created_and_bumps_updated() {
        let (list, id) = upsert(&Value::Array(vec![]), obj(vec![("name", Value::Str("A".into()))]));
        let created = find(&list, &id).unwrap().get_i64("createdAt").unwrap();
        let (list2, _) = upsert(
            &list,
            obj(vec![
                ("id", Value::Str(id.clone())),
                ("name", Value::Str("A renamed".into())),
            ]),
        );
        let item = find(&list2, &id).unwrap();
        assert_eq!(item.get_str("name"), Some("A renamed"));
        assert_eq!(item.get_i64("createdAt"), Some(created));
        assert_eq!(list2.as_array().unwrap().len(), 1);
    }

    #[test]
    fn remove_deletes_by_id() {
        let (list, id) = upsert(&Value::Array(vec![]), obj(vec![("name", Value::Str("A".into()))]));
        let (list, removed) = remove(&list, &id);
        assert!(removed);
        assert_eq!(list.as_array().unwrap().len(), 0);
    }

    #[test]
    fn reorder_follows_ids() {
        let mut list = Value::Array(vec![]);
        let mut ids = vec![];
        for name in ["A", "B", "C"] {
            let (l, id) = upsert(&list, obj(vec![("name", Value::Str(name.into()))]));
            list = l;
            ids.push(id);
        }
        // Reverse the order.
        ids.reverse();
        let list = reorder(&list, &ids);
        let items = list.as_array().unwrap();
        assert_eq!(items[0].get_str("name"), Some("C"));
        assert_eq!(items[0].get_i64("order"), Some(0));
        assert_eq!(items[2].get_str("name"), Some("A"));
    }

    #[test]
    fn default_show_in_band_is_false() {
        let (list, id) = upsert(&Value::Array(vec![]), obj(vec![("name", Value::Str("A".into()))]));
        assert_eq!(find(&list, &id).unwrap().get_bool("showInBand"), Some(false));
        let _ = Obj::new(); // keep import used across cfg
    }
}
