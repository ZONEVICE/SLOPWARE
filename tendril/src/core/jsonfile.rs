//! Typed JSON files, written atomically.
//!
//! Every persisted file in `~/.tendril` goes through here so that a crash
//! mid-write can never corrupt `settings.json` or `recent.json`.

use std::fmt;
use std::fs;
use std::io;
use std::path::Path;

use serde::Serialize;
use serde::de::DeserializeOwned;

use super::atomic;

/// Why a JSON file could not be read.
#[derive(Debug)]
pub enum JsonFileError {
    /// The file exists but could not be read.
    Io(io::Error),
    /// The file is not valid JSON for the expected type.
    Parse { line: usize, column: usize, message: String },
}

impl fmt::Display for JsonFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JsonFileError::Io(err) => write!(f, "{err}"),
            JsonFileError::Parse { line, column, message } => {
                write!(f, "invalid JSON at line {line}, column {column}: {message}")
            }
        }
    }
}

impl std::error::Error for JsonFileError {}

/// Reads and parses `path`. A missing file is `Ok(None)`, not an error.
pub fn read<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, JsonFileError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(JsonFileError::Io(err)),
    };
    // Tolerate a UTF-8 BOM left by Windows editors such as Notepad.
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    serde_json::from_slice(body).map(Some).map_err(|err| {
        // serde_json ends its message with " at line L column C"; the position
        // is kept in its own fields, so drop it from the text.
        let text = err.to_string();
        let position = format!(" at line {} column {}", err.line(), err.column());
        let message = text.strip_suffix(&position).unwrap_or(&text).to_string();
        JsonFileError::Parse { line: err.line(), column: err.column(), message }
    })
}

/// Serializes `value` as pretty JSON (with a trailing newline) and writes it
/// atomically. `private` restricts it to the owner on Unix.
pub fn write<T: Serialize>(path: &Path, value: &T, private: bool) -> io::Result<()> {
    let mut text = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    text.push(b'\n');
    atomic::write(path, &text, private)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::random;
    use serde::Deserialize;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Sample {
        a: u32,
    }

    #[test]
    fn missing_bom_and_errors() {
        let dir = std::env::temp_dir().join(format!("tendril-json-{}", random::token_hex(4)));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x.json");
        assert!(read::<Sample>(&path).unwrap().is_none());

        write(&path, &Sample { a: 7 }, true).unwrap();
        assert_eq!(read::<Sample>(&path).unwrap(), Some(Sample { a: 7 }));

        fs::write(&path, b"\xEF\xBB\xBF{\"a\": 9}").unwrap();
        assert_eq!(read::<Sample>(&path).unwrap(), Some(Sample { a: 9 }));

        fs::write(&path, b"{\n  \"a\": oops\n}").unwrap();
        match read::<Sample>(&path) {
            Err(JsonFileError::Parse { line, .. }) => assert_eq!(line, 2),
            other => panic!("expected a parse error, got {other:?}"),
        }

        // The position is reported once, not repeated inside the message.
        fs::write(&path, b"{ \"a\": 1, }").unwrap();
        match read::<Sample>(&path) {
            Err(err @ JsonFileError::Parse { .. }) => {
                assert_eq!(err.to_string(), "invalid JSON at line 1, column 11: trailing comma");
            }
            other => panic!("expected a parse error, got {other:?}"),
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
