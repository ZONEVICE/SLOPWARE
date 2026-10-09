//! The front end, embedded in the binary with `include_str!` / `include_bytes!`.
//!
//! Every HTML/CSS/JS/SVG asset lives under `src/web/` and is baked into the
//! `.exe` at build time, so the single file is the whole product — no files to
//! ship alongside it. Assets are served with a content hash as the `ETag` so a
//! reload over a slow Bluetooth link only re-sends what changed.
//!
//! Adding an asset is one `embed!` line in [`ASSETS`]; the router serves it
//! automatically.

use crate::http::mime_for;

/// One embedded file: the URL path and its bytes. The content type is derived
/// from the path at serve time (`mime_for` is not const, so it cannot run in
/// the static initializer).
pub struct Asset {
    pub path: &'static str,
    pub bytes: &'static [u8],
}

impl Asset {
    pub fn content_type(&self) -> &'static str {
        mime_for(self.path)
    }
}

macro_rules! embed {
    ($path:expr, $file:expr) => {
        Asset {
            path: $path,
            bytes: include_bytes!($file),
        }
    };
}

/// Every asset the front end is made of. The entry point `index.html` is also
/// served for `/`.
pub static ASSETS: &[Asset] = &[
    embed!("/index.html", "web/index.html"),
    embed!("/styles.css", "web/styles.css"),
    embed!("/app.js", "web/app.js"),
    embed!("/net.js", "web/net.js"),
    embed!("/util.js", "web/util.js"),
    embed!("/themes.js", "web/themes.js"),
    embed!("/mouse.js", "web/mouse.js"),
    embed!("/keyboard.js", "web/keyboard.js"),
    embed!("/masked.js", "web/masked.js"),
    embed!("/settings.js", "web/settings.js"),
    embed!("/band.js", "web/band.js"),
    embed!("/gestures.js", "web/gestures.js"),
    embed!("/icon.svg", "web/icon.svg"),
];

/// Look up an asset by request path. `/` maps to `index.html`.
pub fn lookup(path: &str) -> Option<&'static Asset> {
    let path = if path == "/" { "/index.html" } else { path };
    ASSETS.iter().find(|a| a.path == path)
}

/// A short, stable content hash for use as an `ETag` (FNV-1a, 64-bit).
pub fn etag(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("\"{hash:016x}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_maps_to_index() {
        assert_eq!(lookup("/").unwrap().path, "/index.html");
    }

    #[test]
    fn every_asset_is_nonempty() {
        for asset in ASSETS {
            assert!(!asset.bytes.is_empty(), "{} is empty", asset.path);
        }
    }

    #[test]
    fn etag_is_stable_and_differs() {
        assert_eq!(etag(b"abc"), etag(b"abc"));
        assert_ne!(etag(b"abc"), etag(b"abd"));
    }
}
