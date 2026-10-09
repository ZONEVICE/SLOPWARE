//! A tiny hand-written HTTP/1.1 stack: request parsing, response building, the
//! port walk, and MIME lookup. No framework.

mod listen;
mod request;
mod response;

pub use listen::bind;
pub use request::{read_request, Request};
pub use response::Response;

/// Guess a `Content-Type` from a file extension. Only the types the embedded
/// front end actually uses are listed; anything else is served as octet-stream.
pub fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext.to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_lookup() {
        assert_eq!(mime_for("/app.js"), "text/javascript; charset=utf-8");
        assert_eq!(mime_for("/styles.css"), "text/css; charset=utf-8");
        assert_eq!(mime_for("/icon.svg"), "image/svg+xml");
        assert_eq!(mime_for("/unknown.xyz"), "application/octet-stream");
    }
}
