//! The front end, embedded in the binary.
//!
//! `build.rs` turns every gzip file of `web/dist/` into an entry of
//! [`ASSETS`]. Bytes are served exactly as embedded, with
//! `Content-Encoding: gzip`, so the server never compresses or decompresses
//! anything and an asset costs no heap memory: it is read straight from the
//! binary's read-only data, which the OS pages in on demand. A client that
//! does not accept gzip (every browser does) gets 406.
//!
//! Access rules: `/assets/public/*`, the login page and the icon are served to
//! anyone; everything else requires a session (see `routes::pages`).

use axum::body::Body;
use axum::http::header::{
    ACCEPT_ENCODING, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, ETAG, IF_NONE_MATCH, VARY,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

/// One embedded file.
#[derive(Debug)]
pub struct Asset {
    /// URL path, e.g. `/assets/app/main.js`.
    pub path: &'static str,
    pub mime: &'static str,
    /// Quoted ETag from the gzip CRC-32 and size.
    pub etag: &'static str,
    /// Content-hashed file name: cache forever.
    pub immutable: bool,
    /// Uncompressed size.
    pub size: u32,
    /// The gzip-compressed bytes.
    pub gzip: &'static [u8],
}

include!(concat!(env!("OUT_DIR"), "/assets.rs"));

/// Looks an asset up by URL path.
pub fn find(path: &str) -> Option<&'static Asset> {
    ASSETS.binary_search_by(|asset| asset.path.cmp(path)).ok().map(|i| &ASSETS[i])
}

/// True for assets anyone may fetch without logging in.
pub fn is_public(path: &str) -> bool {
    path.starts_with("/assets/public/") || path == "/login.html" || path == "/favicon.svg"
}

/// True when the `Accept-Encoding` header allows gzip.
fn accepts_gzip(headers: &HeaderMap) -> bool {
    headers.get_all(ACCEPT_ENCODING).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(',')).any(|item| {
        let mut parts = item.trim().split(';');
        let coding = parts.next().unwrap_or("").trim();
        let rejected = parts.any(|p| {
            let p = p.trim();
            p.strip_prefix("q=").is_some_and(|q| q.trim().parse::<f32>().map(|q| q <= 0.0).unwrap_or(false))
        });
        (coding.eq_ignore_ascii_case("gzip") || coding == "*") && !rejected
    })
}

/// The response for an asset, honouring `If-None-Match`.
pub fn respond(asset: &'static Asset, headers: &HeaderMap) -> Response {
    let cache = if asset.immutable { "public, max-age=31536000, immutable" } else { "no-cache" };
    let not_modified = headers
        .get(IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|tag| tag.trim().trim_start_matches("W/") == asset.etag));
    if not_modified {
        let mut response = StatusCode::NOT_MODIFIED.into_response();
        let h = response.headers_mut();
        h.insert(ETAG, HeaderValue::from_static(asset.etag));
        h.insert(CACHE_CONTROL, HeaderValue::from_static(cache));
        return response;
    }
    if !accepts_gzip(headers) {
        return (StatusCode::NOT_ACCEPTABLE, "This server only sends gzip-compressed assets.").into_response();
    }
    let mut response = Response::new(Body::from(asset.gzip));
    let h = response.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static(asset.mime));
    h.insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    h.insert(CONTENT_LENGTH, HeaderValue::from(asset.gzip.len()));
    h.insert(VARY, HeaderValue::from_static("Accept-Encoding"));
    h.insert(ETAG, HeaderValue::from_static(asset.etag));
    h.insert(CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_is_sorted_and_has_the_pages() {
        assert!(ASSETS.windows(2).all(|w| w[0].path < w[1].path));
        assert!(find("/index.html").is_some());
        assert!(find("/login.html").is_some());
        assert!(find("/nope").is_none());
        for asset in ASSETS {
            assert_eq!(&asset.gzip[..2], &[0x1f, 0x8b], "{}", asset.path);
        }
    }

    #[test]
    fn gzip_negotiation() {
        let mut h = HeaderMap::new();
        assert!(!accepts_gzip(&h));
        h.insert(ACCEPT_ENCODING, HeaderValue::from_static("gzip, deflate, br"));
        assert!(accepts_gzip(&h));
        h.insert(ACCEPT_ENCODING, HeaderValue::from_static("br;q=1.0, gzip;q=0"));
        assert!(!accepts_gzip(&h));
        h.insert(ACCEPT_ENCODING, HeaderValue::from_static("*"));
        assert!(accepts_gzip(&h));
    }

    #[test]
    fn public_paths() {
        assert!(is_public("/assets/public/login.js"));
        assert!(is_public("/login.html"));
        assert!(!is_public("/assets/app/main.js"));
        assert!(!is_public("/index.html"));
    }
}
