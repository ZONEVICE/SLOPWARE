//! A response body that streams part of a file from disk.
//!
//! Downloads and media playback never load a whole file into memory: the body
//! reads 64 KiB at a time from `offset` for `remaining` bytes, which is also
//! what HTTP `Range` requests (seeking in a video) need.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll, ready};

use axum::body::Bytes;
use http_body::{Body, Frame, SizeHint};
use tokio::io::{AsyncRead, ReadBuf};

/// Bytes read per frame.
const CHUNK: usize = 64 * 1024;

/// Streams `remaining` bytes of an already-positioned file.
pub struct FileBody {
    file: tokio::fs::File,
    remaining: u64,
    buf: Vec<u8>,
}

impl FileBody {
    /// `file` must already be seeked to the first byte to send.
    pub fn new(file: tokio::fs::File, length: u64) -> FileBody {
        FileBody { file, remaining: length, buf: vec![0; CHUNK.min(length.max(1) as usize)] }
    }
}

impl Body for FileBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        let this = &mut *self;
        if this.remaining == 0 {
            return Poll::Ready(None);
        }
        let want = (this.remaining as usize).min(this.buf.len());
        let mut read_buf = ReadBuf::new(&mut this.buf[..want]);
        ready!(Pin::new(&mut this.file).poll_read(cx, &mut read_buf))?;
        let filled = read_buf.filled();
        if filled.is_empty() {
            // The file shrank while being sent.
            return Poll::Ready(Some(Err(io::Error::new(io::ErrorKind::UnexpectedEof, "file truncated"))));
        }
        this.remaining -= filled.len() as u64;
        Poll::Ready(Some(Ok(Frame::data(Bytes::copy_from_slice(filled)))))
    }

    fn is_end_stream(&self) -> bool {
        self.remaining == 0
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.remaining)
    }
}

/// A parsed `Range` header against a file of `size` bytes.
#[derive(Debug, PartialEq, Eq)]
pub enum Range {
    /// No (usable) range: send everything.
    Full,
    /// Inclusive byte range.
    Part { start: u64, end: u64 },
    /// The range cannot be satisfied (416).
    Unsatisfiable,
}

/// Parses `bytes=a-b`, `bytes=a-` and `bytes=-n`. Multiple ranges are not
/// supported and fall back to the full file, which RFC 9110 allows.
pub fn parse_range(header: Option<&str>, size: u64) -> Range {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else { return Range::Full };
    if spec.contains(',') {
        return Range::Full;
    }
    let Some((a, b)) = spec.trim().split_once('-') else { return Range::Full };
    let (a, b) = (a.trim(), b.trim());
    let parsed = if a.is_empty() {
        // Suffix: the last n bytes.
        match b.parse::<u64>() {
            Ok(0) | Err(_) => return Range::Unsatisfiable,
            Ok(n) => (size.saturating_sub(n), size.saturating_sub(1)),
        }
    } else {
        let Ok(start) = a.parse::<u64>() else { return Range::Full };
        let end = if b.is_empty() {
            size.saturating_sub(1)
        } else {
            match b.parse::<u64>() {
                Ok(end) => end.min(size.saturating_sub(1)),
                Err(_) => return Range::Full,
            }
        };
        (start, end)
    };
    let (start, end) = parsed;
    if size == 0 || start >= size || start > end {
        return Range::Unsatisfiable;
    }
    Range::Part { start, end }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range(None, 100), Range::Full);
        assert_eq!(parse_range(Some("bytes=0-9"), 100), Range::Part { start: 0, end: 9 });
        assert_eq!(parse_range(Some("bytes=90-"), 100), Range::Part { start: 90, end: 99 });
        assert_eq!(parse_range(Some("bytes=-10"), 100), Range::Part { start: 90, end: 99 });
        assert_eq!(parse_range(Some("bytes=50-1000"), 100), Range::Part { start: 50, end: 99 });
        assert_eq!(parse_range(Some("bytes=100-"), 100), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=5-2"), 100), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), Range::Full);
        assert_eq!(parse_range(Some("items=0-1"), 100), Range::Full);
        assert_eq!(parse_range(Some("bytes=0-0"), 0), Range::Unsatisfiable);
    }
}
