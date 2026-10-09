//! Cryptographic randomness from the OS CSPRNG.
//!
//! The PIN and session tokens must be unpredictable, so they come from
//! `BCryptGenRandom` with the system-preferred RNG — never from the clock or a
//! hash of the time.

use super::ffi::*;

/// Fill `buf` with cryptographically secure random bytes. Panics if the OS
/// RNG fails, which on a healthy system does not happen; the caller runs this
/// once at startup where a panic is acceptable.
pub fn fill_random(buf: &mut [u8]) {
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buf.as_mut_ptr(),
            buf.len() as ULONG,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        panic!("BCryptGenRandom failed with NTSTATUS {status:#x}");
    }
}

/// Return `n` random bytes.
pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    fill_random(&mut v);
    v
}
