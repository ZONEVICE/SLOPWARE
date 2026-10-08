//! Content hashing.
//!
//! Hashes are only computed when size and mtime cannot decide: two files of
//! the same size whose mtimes differ, typically because one side received its
//! copy by some other means before the first sync.

use crate::util::ids::hex;
use ring::digest::{Context, SHA256};
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

/// SHA-256 of a file, hex encoded.
pub fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut context = Context::new(&SHA256);
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        context.update(&buffer[..read]);
    }
    Ok(hex(context.finish().as_ref()))
}
