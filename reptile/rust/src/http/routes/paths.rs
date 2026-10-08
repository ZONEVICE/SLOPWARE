//! Live validation of the directories typed into the control panel, and the
//! content tree of the "Host a directory" screen.

use crate::domain::errors::AppError;
use crate::fs::path_check::{check_host_directory, check_sync_directory};
use crate::fs::walk::build_tree;
use crate::http::router::{Access, Router};
use crate::http::routes::Deps;
use crate::http::server::Reply;
use crate::util::sys::home_dir;
use serde_json::{json, Value};
use std::sync::Arc;

/// A directory name derived from a hosted directory's display name.
fn safe_folder_name(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0') { ' ' } else { c })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned: String = collapsed.trim_start_matches('.').chars().take(80).collect();
    if cleaned.is_empty() {
        "Reptile".into()
    } else {
        cleaned
    }
}

pub fn register(router: &mut Router, _deps: &Arc<Deps>) {
    router.add("POST", "/api/paths/check", Access::Ui, |request| {
        let body = request.read_json(1024 * 1024)?;
        let path = body.get("path").and_then(Value::as_str);
        let result = match body.get("purpose").and_then(Value::as_str) {
            Some("host") => check_host_directory(path),
            Some("sync") => check_sync_directory(path),
            _ => return Err(AppError::bad_request("purpose must be \"host\" or \"sync\".", "bad_request")),
        };
        Ok(Reply::json(200, &result.to_json()))
    });

    router.add("POST", "/api/paths/tree", Access::Ui, |request| {
        let body = request.read_json(1024 * 1024)?;
        let check = check_host_directory(body.get("path").and_then(Value::as_str));
        if !check.ok {
            return Err(AppError::bad_request(check.message, "invalid_path"));
        }
        let path = check.path.unwrap_or_default();
        let (mut tree, total, truncated) = build_tree(std::path::Path::new(&path), 250_000)
            .map_err(|error| AppError::bad_request(error.to_string(), "invalid_path"))?;
        tree["name"] = json!(path);
        Ok(Reply::json(200, &json!({ "path": path, "tree": tree, "total": total, "truncated": truncated })))
    });

    router.add("GET", "/api/paths/suggest", Access::Ui, |request| {
        let name = safe_folder_name(&request.query_param("name").unwrap_or_default());
        Ok(Reply::json(200, &json!({ "path": home_dir().join(name).to_string_lossy() })))
    });
}

#[cfg(test)]
mod tests {
    use super::safe_folder_name;

    #[test]
    fn folder_names() {
        assert_eq!(safe_folder_name("My: Docs/2024"), "My Docs 2024");
        assert_eq!(safe_folder_name("..hidden"), "hidden");
        assert_eq!(safe_folder_name("  "), "Reptile");
    }
}
