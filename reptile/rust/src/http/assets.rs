//! The control panel's files.
//!
//! They are the Node.js implementation's `public/` directory, compiled into
//! the binary by `build.rs`, so the executable is self-contained. Setting
//! `REPTILE_PUBLIC_DIR` serves them from a directory instead, which is handy
//! while editing the front end. The client routes with the URL hash, so every
//! real path maps to a real file or to a 404.

use crate::http::server::{Reply, ReplyBody};
use crate::util::url::decode_component;
use std::path::{Component, Path, PathBuf};

include!(concat!(env!("OUT_DIR"), "/assets.rs"));

/// The control panel may only talk to its own origin.
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

fn mime(path: &str) -> &'static str {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

pub struct Statics {
    directory: Option<PathBuf>,
}

impl Statics {
    pub fn new(directory: Option<PathBuf>) -> Statics {
        Statics { directory }
    }

    /// The relative path a URL path names, or None when it cannot be a file.
    fn relative(pathname: &str) -> Option<String> {
        let decoded = decode_component(pathname)?;
        if decoded.contains('\0') {
            return None;
        }
        let relative = decoded.trim_start_matches('/');
        let relative = if relative.is_empty() { "index.html" } else { relative };
        if !Path::new(relative).components().all(|c| matches!(c, Component::Normal(_))) {
            return None;
        }
        Some(relative.to_string())
    }

    fn found(relative: &str, body: ReplyBody) -> Reply {
        Reply::new(
            200,
            vec![
                ("Content-Type".into(), mime(relative).into()),
                // No build step means no content hashes: always revalidate.
                ("Cache-Control".into(), "no-cache".into()),
                ("Content-Security-Policy".into(), CONTENT_SECURITY_POLICY.into()),
            ],
            body,
        )
    }

    /// A file for a GET/HEAD path, or None.
    pub fn serve(&self, pathname: &str) -> Option<Reply> {
        let relative = Statics::relative(pathname)?;
        if let Some(directory) = &self.directory {
            let target = directory.join(&relative);
            let meta = std::fs::metadata(&target).ok()?;
            if !meta.is_file() {
                return None;
            }
            let file = std::fs::File::open(&target).ok()?;
            return Some(Statics::found(&relative, ReplyBody::File { file, length: meta.len() }));
        }
        let (_, bytes) = ASSETS.iter().find(|(name, _)| *name == relative)?;
        Some(Statics::found(&relative, ReplyBody::Bytes(bytes.to_vec())))
    }
}

/// Minimal HTML 404.
pub fn not_found() -> Reply {
    Reply::html(404, "<!doctype html><meta charset=\"utf-8\"><title>Not found</title><p>Not found.</p>")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_panel_is_there() {
        assert!(ASSETS.iter().any(|(name, _)| *name == "index.html"));
        assert!(ASSETS.iter().any(|(name, _)| *name == "js/main.js"));
        let statics = Statics::new(None);
        assert!(statics.serve("/").is_some());
        assert!(statics.serve("/js/main.js").is_some());
        assert!(statics.serve("/../Cargo.toml").is_none());
        assert!(statics.serve("/%2e%2e/x").is_none());
        assert!(statics.serve("/missing.js").is_none());
    }
}
