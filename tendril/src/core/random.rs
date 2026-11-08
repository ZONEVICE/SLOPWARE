//! The operating system's CSPRNG, and the secrets Tendril derives from it.
//!
//! `ring::rand::SystemRandom` is already in the dependency tree (rustls and
//! rcgen use it); it reads `getrandom(2)` on Linux and `ProcessPrng` /
//! `BCryptGenRandom` on Windows. If the OS cannot produce randomness Tendril
//! cannot run securely at all, so failure panics.

use ring::rand::{SecureRandom, SystemRandom};

/// Alphabet for generated passwords: letters and digits without the
/// look-alikes `0 O o 1 l I`, so a password read off a console is never
/// mistyped. 56 symbols, 8 of them give ~46 bits of entropy, which is plenty
/// with a three-attempt lockout per IP.
pub const PASSWORD_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/// Fills `buf` with cryptographically secure random bytes.
pub fn fill(buf: &mut [u8]) {
    SystemRandom::new().fill(buf).expect("the operating system's random number generator failed");
}

/// `N` random bytes.
pub fn bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    fill(&mut out);
    out
}

/// Lowercase hex encoding.
pub fn hex(data: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(data.len() * 2);
    for byte in data {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Decodes lowercase or uppercase hex into exactly `N` bytes.
pub fn unhex<const N: usize>(text: &str) -> Option<[u8; N]> {
    let raw = text.as_bytes();
    if raw.len() != N * 2 {
        return None;
    }
    let nibble = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    let mut out = [0u8; N];
    for (i, pair) in raw.chunks_exact(2).enumerate() {
        out[i] = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Some(out)
}

/// A random hex string of `n_bytes` bytes of entropy.
pub fn token_hex(n_bytes: usize) -> String {
    let mut buf = vec![0u8; n_bytes];
    fill(&mut buf);
    hex(&buf)
}

/// A random string of `len` symbols drawn uniformly from `alphabet`.
///
/// Uses rejection sampling so that no symbol is more likely than another
/// (a plain `byte % alphabet.len()` would favour the first symbols).
pub fn string_from(alphabet: &[u8], len: usize) -> String {
    assert!(!alphabet.is_empty() && alphabet.len() <= 256);
    let limit = 256 - (256 % alphabet.len()); // largest multiple of len <= 256
    let mut out = String::with_capacity(len);
    let mut pool = [0u8; 64];
    while out.len() < len {
        fill(&mut pool);
        for &b in pool.iter() {
            if (b as usize) < limit {
                out.push(alphabet[b as usize % alphabet.len()] as char);
                if out.len() == len {
                    break;
                }
            }
        }
    }
    out
}

/// The 8-character password shown once in the console when none is set.
pub fn password() -> String {
    string_from(PASSWORD_ALPHABET, 8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords_are_eight_unambiguous_alphanumerics() {
        for _ in 0..200 {
            let p = password();
            assert_eq!(p.len(), 8);
            assert!(p.bytes().all(|b| b.is_ascii_alphanumeric()));
            assert!(!p.contains(['0', 'O', 'o', '1', 'l', 'I']));
        }
        assert_ne!(password(), password());
    }

    #[test]
    fn hex_round_trip() {
        let data: [u8; 16] = bytes();
        let text = hex(&data);
        assert_eq!(text.len(), 32);
        assert_eq!(unhex::<16>(&text), Some(data));
        assert_eq!(unhex::<16>(&text.to_uppercase()), Some(data));
        assert_eq!(unhex::<16>("zz"), None);
        assert_eq!(unhex::<2>("abcg"), None);
    }

    #[test]
    fn every_symbol_can_appear() {
        let sample = string_from(b"abc", 3000);
        for c in ['a', 'b', 'c'] {
            assert!(sample.matches(c).count() > 800, "{c} is under-represented");
        }
    }
}
