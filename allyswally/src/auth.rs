//! PIN authentication, session tokens and per-IP lockout.
//!
//! On a new connection the client must present the 6-character PIN shown on the
//! host console. Three wrong tries lock that IP until the process restarts —
//! by design there is no in-app unlock. A correct PIN mints a random session
//! token the client stores and presents when its WebSocket reconnects, so a
//! brief network drop does not re-prompt. Everything lives in memory and is
//! gone on restart; regenerating the PIN invalidates every token.

use crate::win::crypto::random_bytes;
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::time::{SystemTime, UNIX_EPOCH};

/// PIN alphabet: A–Z and 0–9 minus the visually ambiguous `O 0 I 1 L`, so a PIN
/// read off a handheld screen is unmistakable.
const PIN_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PIN_LEN: usize = 6;
const MAX_ATTEMPTS: u32 = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthError {
    /// This IP is locked out after too many wrong PINs.
    Locked,
    /// Wrong PIN; this many tries remain before lockout.
    Wrong { remaining: u32 },
}

#[derive(Clone)]
pub struct Session {
    pub token: String,
    pub ip: IpAddr,
    pub created_unix: u64,
    pub user_agent: String,
}

struct Inner {
    pin: String,
    sessions: HashMap<String, Session>,
    attempts: HashMap<IpAddr, u32>,
    locked: HashSet<IpAddr>,
}

use std::sync::Mutex;

pub struct Auth {
    inner: Mutex<Inner>,
}

impl Auth {
    pub fn new() -> Auth {
        Auth {
            inner: Mutex::new(Inner {
                pin: generate_pin(),
                sessions: HashMap::new(),
                attempts: HashMap::new(),
                locked: HashSet::new(),
            }),
        }
    }

    pub fn pin(&self) -> String {
        self.inner.lock().unwrap().pin.clone()
    }

    /// Generate a fresh PIN, drop every session (kicking all clients) and
    /// return the new PIN. Lockouts are intentionally left intact.
    pub fn regenerate_pin(&self) -> String {
        let mut inner = self.inner.lock().unwrap();
        inner.pin = generate_pin();
        inner.sessions.clear();
        inner.pin.clone()
    }

    pub fn is_locked(&self, ip: &IpAddr) -> bool {
        self.inner.lock().unwrap().locked.contains(ip)
    }

    /// Validate a PIN attempt from `ip`. On success returns a new session token.
    pub fn verify_pin(&self, ip: IpAddr, attempt: &str, user_agent: &str) -> Result<String, AuthError> {
        let mut inner = self.inner.lock().unwrap();
        if inner.locked.contains(&ip) {
            return Err(AuthError::Locked);
        }
        // Constant-time-ish compare is unnecessary for a local 6-char PIN, but
        // normalise case because the input field upper-cases.
        if attempt.eq_ignore_ascii_case(&inner.pin) {
            inner.attempts.remove(&ip);
            let token = generate_token();
            let session = Session {
                token: token.clone(),
                ip,
                created_unix: now_unix(),
                user_agent: user_agent.to_string(),
            };
            inner.sessions.insert(token.clone(), session);
            Ok(token)
        } else {
            let count = inner.attempts.entry(ip).or_insert(0);
            *count += 1;
            if *count >= MAX_ATTEMPTS {
                inner.locked.insert(ip);
                Err(AuthError::Locked)
            } else {
                Err(AuthError::Wrong {
                    remaining: MAX_ATTEMPTS - *count,
                })
            }
        }
    }

    /// True if `token` names a live session.
    pub fn check_token(&self, token: &str) -> bool {
        self.inner.lock().unwrap().sessions.contains_key(token)
    }

    /// The session for a token, if any (for reporting connection info).
    pub fn session(&self, token: &str) -> Option<Session> {
        self.inner.lock().unwrap().sessions.get(token).cloned()
    }

    /// Forget a single session (device logout).
    pub fn logout(&self, token: &str) {
        self.inner.lock().unwrap().sessions.remove(token);
    }

    /// Snapshot of live sessions, for the connected-clients list.
    pub fn sessions(&self) -> Vec<Session> {
        self.inner.lock().unwrap().sessions.values().cloned().collect()
    }
}

impl Default for Auth {
    fn default() -> Self {
        Auth::new()
    }
}

/// Draw a PIN from the ambiguity-free alphabet using the OS CSPRNG, with
/// rejection sampling so every symbol is equally likely (no modulo bias).
pub fn generate_pin() -> String {
    let n = PIN_ALPHABET.len() as u16;
    let limit = (256u16 / n) * n; // largest multiple of n below 256
    let mut out = String::with_capacity(PIN_LEN);
    while out.len() < PIN_LEN {
        for &byte in random_bytes(PIN_LEN).iter() {
            if (byte as u16) < limit {
                out.push(PIN_ALPHABET[(byte as usize) % PIN_ALPHABET.len()] as char);
                if out.len() == PIN_LEN {
                    break;
                }
            }
        }
    }
    out
}

/// A 128-bit random session token, hex-encoded.
pub fn generate_token() -> String {
    random_bytes(16).iter().map(|b| format!("{b:02x}")).collect()
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn ip(n: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, n))
    }

    #[test]
    fn pin_shape_and_alphabet() {
        for _ in 0..200 {
            let pin = generate_pin();
            assert_eq!(pin.len(), PIN_LEN);
            for c in pin.bytes() {
                assert!(PIN_ALPHABET.contains(&c), "unexpected char {c}");
                assert!(!b"O0I1L".contains(&c), "ambiguous char {c}");
            }
        }
    }

    #[test]
    fn correct_pin_issues_token() {
        let auth = Auth::new();
        let pin = auth.pin();
        let token = auth.verify_pin(ip(1), &pin, "ua").unwrap();
        assert!(auth.check_token(&token));
    }

    #[test]
    fn pin_is_case_insensitive() {
        let auth = Auth::new();
        let pin = auth.pin().to_lowercase();
        assert!(auth.verify_pin(ip(9), &pin, "ua").is_ok());
    }

    #[test]
    fn three_wrong_tries_lock_the_ip() {
        let auth = Auth::new();
        assert_eq!(
            auth.verify_pin(ip(2), "WRONG1", "ua"),
            Err(AuthError::Wrong { remaining: 2 })
        );
        assert_eq!(
            auth.verify_pin(ip(2), "WRONG2", "ua"),
            Err(AuthError::Wrong { remaining: 1 })
        );
        assert_eq!(auth.verify_pin(ip(2), "WRONG3", "ua"), Err(AuthError::Locked));
        assert!(auth.is_locked(&ip(2)));
        // Even the correct PIN is refused once locked.
        let pin = auth.pin();
        assert_eq!(auth.verify_pin(ip(2), &pin, "ua"), Err(AuthError::Locked));
    }

    #[test]
    fn lockout_is_per_ip() {
        let auth = Auth::new();
        for _ in 0..3 {
            let _ = auth.verify_pin(ip(3), "NOPE12", "ua");
        }
        assert!(auth.is_locked(&ip(3)));
        assert!(!auth.is_locked(&ip(4)));
    }

    #[test]
    fn regenerate_invalidates_sessions() {
        let auth = Auth::new();
        let pin = auth.pin();
        let token = auth.verify_pin(ip(5), &pin, "ua").unwrap();
        assert!(auth.check_token(&token));
        auth.regenerate_pin();
        assert!(!auth.check_token(&token));
    }

    #[test]
    fn logout_forgets_one_session() {
        let auth = Auth::new();
        let pin = auth.pin();
        let token = auth.verify_pin(ip(6), &pin, "ua").unwrap();
        auth.logout(&token);
        assert!(!auth.check_token(&token));
    }
}
