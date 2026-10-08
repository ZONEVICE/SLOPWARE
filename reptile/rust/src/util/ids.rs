//! Identifiers and secrets, from the operating system's random source.

use ring::rand::{SecureRandom, SystemRandom};
use std::sync::OnceLock;

fn rng() -> &'static SystemRandom {
    static RNG: OnceLock<SystemRandom> = OnceLock::new();
    RNG.get_or_init(SystemRandom::new)
}

/// Fill a buffer with cryptographically secure random bytes.
pub fn random_bytes(buffer: &mut [u8]) {
    rng().fill(buffer).expect("the system random source failed");
}

/// The process-wide random generator, for APIs that take one (key generation).
pub fn system_random() -> &'static SystemRandom {
    rng()
}

/// Lowercase hexadecimal.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 15) as usize] as char);
    }
    out
}

/// A random UUIDv4, e.g. the per-process session id shown in the status bar.
pub fn new_uuid() -> String {
    let mut bytes = [0u8; 16];
    random_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h = hex(&bytes);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// An unguessable bearer token for an authorised peer session.
pub fn new_token() -> String {
    random_hex(24)
}

/// `bytes` random bytes as hex, for temporary file names.
pub fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    random_bytes(&mut buffer);
    hex(&buffer)
}

/// A uniformly distributed integer in `0..bound`.
pub fn random_below(bound: u32) -> u32 {
    assert!(bound > 0);
    // Rejection sampling: drop the top values that would bias the modulo.
    let zone = u32::MAX - (u32::MAX % bound);
    loop {
        let mut buffer = [0u8; 4];
        random_bytes(&mut buffer);
        let value = u32::from_le_bytes(buffer);
        if value < zone {
            return value % bound;
        }
    }
}

/// Constant-time comparison. The PIN is openly a symbolic secret, but there is
/// no reason to leak it through timing either.
pub fn safe_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_is_version_4() {
        let uuid = new_uuid();
        assert_eq!(uuid.len(), 36);
        assert_eq!(&uuid[14..15], "4");
        assert!(matches!(&uuid[19..20], "8" | "9" | "a" | "b"));
        assert_ne!(uuid, new_uuid());
    }

    #[test]
    fn tokens_and_comparison() {
        assert_eq!(new_token().len(), 48);
        assert!(safe_eq("1234", "1234"));
        assert!(!safe_eq("1234", "1235"));
        assert!(!safe_eq("1234", "12345"));
        for _ in 0..1000 {
            assert!(random_below(10_000) < 10_000);
        }
    }
}
