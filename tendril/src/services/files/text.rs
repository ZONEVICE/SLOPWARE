//! Text files: UTF-8 with an optional BOM and LF or CRLF line endings.
//!
//! The browser always edits LF-only text without a BOM. On the way in,
//! [`decode`] strips the BOM and converts CRLF to LF, remembering both; on the
//! way out, [`encode`] puts them back, so a Windows file saved from Tendril
//! keeps its CRLF and its BOM. A file with mixed line endings is saved with
//! the majority style (the same thing VS Code does).
//!
//! A file is "binary" when its first 8 KiB contain a NUL byte or it is not
//! valid UTF-8; such files are never opened in the editor (UTF-16 files
//! contain NULs and are treated the same way).

use std::borrow::Cow;

use serde::{Deserialize, Serialize};

use super::{FsError, FsResult};

/// UTF-8 byte order mark.
pub const BOM: &[u8] = b"\xEF\xBB\xBF";
/// How much of a file is inspected for NUL bytes.
pub const SNIFF_LEN: usize = 8192;

/// Line ending style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
}

impl Eol {
    /// Parses `lf` / `crlf` (case-insensitive).
    pub fn parse(text: &str) -> Option<Eol> {
        match text.to_ascii_lowercase().as_str() {
            "lf" => Some(Eol::Lf),
            "crlf" => Some(Eol::Crlf),
            _ => None,
        }
    }

    /// `lf` or `crlf`.
    pub fn as_str(self) -> &'static str {
        match self {
            Eol::Lf => "lf",
            Eol::Crlf => "crlf",
        }
    }
}

/// A decoded text file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decoded {
    /// Content with LF line endings and no BOM.
    pub text: String,
    /// Dominant line ending of the original.
    pub eol: Eol,
    /// The original started with a UTF-8 BOM.
    pub bom: bool,
}

/// True when the start of a file looks binary (contains NUL).
pub fn looks_binary(head: &[u8]) -> bool {
    head[..head.len().min(SNIFF_LEN)].contains(&0)
}

/// Decodes raw bytes into editor text.
pub fn decode(mut bytes: Vec<u8>) -> FsResult<Decoded> {
    let bom = bytes.starts_with(BOM);
    if bom {
        bytes.drain(..BOM.len());
    }
    if looks_binary(&bytes) {
        return Err(FsError::Binary);
    }
    let text = String::from_utf8(bytes).map_err(|_| FsError::Binary)?;
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    let eol = if crlf > lf { Eol::Crlf } else { Eol::Lf };
    let text = if crlf > 0 { text.replace("\r\n", "\n") } else { text };
    Ok(Decoded { text, eol, bom })
}

/// Encodes editor text for disk with the given line ending and BOM.
pub fn encode(text: &str, eol: Eol, bom: bool) -> Vec<u8> {
    // Normalise first so stray CRLFs are not doubled into CRCRLF.
    let text: Cow<'_, str> = if text.contains("\r\n") { Cow::Owned(text.replace("\r\n", "\n")) } else { text.into() };
    let extra = match eol {
        Eol::Lf => 0,
        Eol::Crlf => text.matches('\n').count(),
    };
    let mut out = Vec::with_capacity(text.len() + extra + if bom { BOM.len() } else { 0 });
    if bom {
        out.extend_from_slice(BOM);
    }
    match eol {
        Eol::Lf => out.extend_from_slice(text.as_bytes()),
        Eol::Crlf => {
            for (i, line) in text.split('\n').enumerate() {
                if i > 0 {
                    out.extend_from_slice(b"\r\n");
                }
                out.extend_from_slice(line.as_bytes());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lf_files_round_trip() {
        let d = decode(b"a\nb\n".to_vec()).unwrap();
        assert_eq!(d, Decoded { text: "a\nb\n".into(), eol: Eol::Lf, bom: false });
        assert_eq!(encode(&d.text, d.eol, d.bom), b"a\nb\n");
    }

    #[test]
    fn crlf_and_bom_are_preserved() {
        let raw = b"\xEF\xBB\xBFline1\r\nline2\r\n".to_vec();
        let d = decode(raw.clone()).unwrap();
        assert_eq!(d.text, "line1\nline2\n");
        assert_eq!(d.eol, Eol::Crlf);
        assert!(d.bom);
        assert_eq!(encode(&d.text, d.eol, d.bom), raw);
    }

    #[test]
    fn mixed_endings_follow_the_majority() {
        let d = decode(b"a\r\nb\r\nc\nd".to_vec()).unwrap();
        assert_eq!(d.eol, Eol::Crlf);
        assert_eq!(encode(&d.text, d.eol, false), b"a\r\nb\r\nc\r\nd");
        let d = decode(b"a\nb\nc\r\n".to_vec()).unwrap();
        assert_eq!(d.eol, Eol::Lf);
    }

    #[test]
    fn stray_crlf_in_input_is_not_doubled() {
        assert_eq!(encode("a\r\nb", Eol::Crlf, false), b"a\r\nb");
    }

    #[test]
    fn binary_and_invalid_utf8_are_refused() {
        assert!(matches!(decode(vec![0x89, b'P', b'N', b'G', 0, 0]), Err(FsError::Binary)));
        assert!(matches!(decode(vec![b'a', 0xff, 0xfe]), Err(FsError::Binary)));
        // UTF-16 LE "hi" with BOM.
        assert!(matches!(decode(vec![0xff, 0xfe, b'h', 0, b'i', 0]), Err(FsError::Binary)));
        assert!(looks_binary(b"abc\0def"));
        assert!(!looks_binary("ñandú ✓".as_bytes()));
    }

    #[test]
    fn empty_files_are_lf() {
        assert_eq!(decode(Vec::new()).unwrap().eol, Eol::Lf);
        assert_eq!(Eol::parse("CRLF"), Some(Eol::Crlf));
        assert_eq!(Eol::parse("x"), None);
    }
}
