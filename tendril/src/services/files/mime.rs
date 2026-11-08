//! Content types for files served from a workspace, and which of them open in
//! a built-in viewer instead of the editor.
//!
//! A short hand-written table: only media the browser can display natively
//! matters here. Everything else is served as `application/octet-stream` for
//! download, never rendered.

/// Built-in viewers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Viewer {
    Image,
    Video,
    Audio,
    Pdf,
}

impl Viewer {
    /// `image`, `video`, `audio` or `pdf`.
    pub fn as_str(self) -> &'static str {
        match self {
            Viewer::Image => "image",
            Viewer::Video => "video",
            Viewer::Audio => "audio",
            Viewer::Pdf => "pdf",
        }
    }
}

/// (extension, content type, viewer)
const TABLE: &[(&str, &str, Viewer)] = &[
    ("png", "image/png", Viewer::Image),
    ("apng", "image/apng", Viewer::Image),
    ("jpg", "image/jpeg", Viewer::Image),
    ("jpeg", "image/jpeg", Viewer::Image),
    ("jfif", "image/jpeg", Viewer::Image),
    ("gif", "image/gif", Viewer::Image),
    ("webp", "image/webp", Viewer::Image),
    ("avif", "image/avif", Viewer::Image),
    ("bmp", "image/bmp", Viewer::Image),
    ("ico", "image/x-icon", Viewer::Image),
    ("svg", "image/svg+xml", Viewer::Image),
    ("mp4", "video/mp4", Viewer::Video),
    ("m4v", "video/mp4", Viewer::Video),
    ("webm", "video/webm", Viewer::Video),
    ("ogv", "video/ogg", Viewer::Video),
    ("mov", "video/quicktime", Viewer::Video),
    ("mkv", "video/x-matroska", Viewer::Video),
    ("mp3", "audio/mpeg", Viewer::Audio),
    ("wav", "audio/wav", Viewer::Audio),
    ("ogg", "audio/ogg", Viewer::Audio),
    ("oga", "audio/ogg", Viewer::Audio),
    ("opus", "audio/ogg", Viewer::Audio),
    ("flac", "audio/flac", Viewer::Audio),
    ("m4a", "audio/mp4", Viewer::Audio),
    ("aac", "audio/aac", Viewer::Audio),
    ("weba", "audio/webm", Viewer::Audio),
    ("pdf", "application/pdf", Viewer::Pdf),
];

fn lookup(name: &str) -> Option<&'static (&'static str, &'static str, Viewer)> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    TABLE.iter().find(|(e, _, _)| *e == ext)
}

/// The viewer for a file name, if it has one.
pub fn viewer(name: &str) -> Option<Viewer> {
    lookup(name).map(|(_, _, v)| *v)
}

/// The content type to serve a workspace file with.
pub fn content_type(name: &str) -> &'static str {
    lookup(name).map(|(_, t, _)| *t).unwrap_or("application/octet-stream")
}

/// True for content types that can carry active content (scripts) if a
/// browser rendered them as a document: they get a sandboxing CSP.
pub fn is_active(content_type: &str) -> bool {
    content_type == "image/svg+xml" || content_type == "application/octet-stream"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookups_are_case_insensitive() {
        assert_eq!(viewer("Photo.JPG"), Some(Viewer::Image));
        assert_eq!(viewer("movie.webm"), Some(Viewer::Video));
        assert_eq!(viewer("song.mp3"), Some(Viewer::Audio));
        assert_eq!(viewer("paper.pdf"), Some(Viewer::Pdf));
        assert_eq!(viewer("main.rs"), None);
        assert_eq!(viewer("Makefile"), None);
        assert_eq!(content_type("index.html"), "application/octet-stream");
        assert_eq!(content_type("logo.svg"), "image/svg+xml");
        assert!(is_active("image/svg+xml"));
        assert!(!is_active("image/png"));
    }
}
