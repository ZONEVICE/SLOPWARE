//! Password login, in-memory sessions and the per-IP blacklist.
//!
//! - **Password.** Priority: `--password`, then `settings.json`, then a random
//!   8-character password printed once (decided in `app.rs`). Only its
//!   SHA-256 digest is kept, and candidates are compared digest to digest in
//!   constant time (`subtle`), so neither the content nor the length leaks
//!   through timing.
//! - **Blacklist.** Three wrong passwords from one IP block that IP until the
//!   process restarts; a blocked IP gets 403 on everything (enforced by the
//!   HTTP guard). The check and the increment happen under one lock, so
//!   parallel attempts can never get past the limit. A correct password
//!   resets the count. Everyone behind the same public IP or VPN exit shares
//!   the count - documented in CLAUDE.md.
//! - **Sessions.** A token is 16 random bytes of id plus 32 random bytes
//!   (256 bits) of secret, hex-encoded. Sessions live only in memory, so a
//!   restart logs everyone out. The id finds the record; the secret is
//!   compared in constant time.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Mutex, RwLock};

use ring::digest;
use subtle::ConstantTimeEq;

use crate::core::clock;
use crate::core::lock::{LockExt, RwLockExt};
use crate::core::random;

/// Wrong passwords tolerated per IP; the next state is "blocked".
pub const MAX_FAILURES: u8 = 3;
/// Sessions kept at most; the least recently used is evicted beyond this.
pub const MAX_SESSIONS: usize = 64;

/// Where the active password came from (shown in the Settings tab).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordSource {
    Cli,
    Settings,
    Random,
}

impl PasswordSource {
    /// `cli`, `settings` or `random`.
    pub fn as_str(self) -> &'static str {
        match self {
            PasswordSource::Cli => "cli",
            PasswordSource::Settings => "settings",
            PasswordSource::Random => "random",
        }
    }
}

/// Identifies a session without carrying its secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionId(pub [u8; 16]);

/// Outcome of a login attempt.
#[derive(Debug, PartialEq, Eq)]
pub enum LoginResult {
    /// Correct password: the new session and its token for the cookie.
    Ok { id: SessionId, token: String },
    /// Wrong password; `remaining` attempts before the IP is blocked.
    Wrong { remaining: u8 },
    /// The IP is blocked. `just_now` is true for the attempt that blocked it.
    Blocked { just_now: bool },
}

struct SessionRecord {
    secret: [u8; 32],
    last_ms: u64,
}

/// Authentication state.
pub struct Auth {
    digest: RwLock<[u8; 32]>,
    source: RwLock<PasswordSource>,
    failures: Mutex<HashMap<IpAddr, u8>>,
    sessions: Mutex<HashMap<SessionId, SessionRecord>>,
}

fn sha256(text: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(digest::digest(&digest::SHA256, text.as_bytes()).as_ref());
    out
}

impl Auth {
    /// Authentication with `password` as the only valid password.
    pub fn new(password: &str, source: PasswordSource) -> Auth {
        Auth {
            digest: RwLock::new(sha256(password)),
            source: RwLock::new(source),
            failures: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Replaces the password for future logins. Existing sessions stay valid.
    pub fn set_password(&self, password: &str, source: PasswordSource) {
        *self.digest.write_ok() = sha256(password);
        *self.source.write_ok() = source;
    }

    /// Where the active password came from.
    pub fn password_source(&self) -> PasswordSource {
        *self.source.read_ok()
    }

    /// True when `ip` used up its attempts.
    pub fn is_blocked(&self, ip: IpAddr) -> bool {
        self.failures.locked().get(&ip).is_some_and(|n| *n >= MAX_FAILURES)
    }

    /// Every blocked IP, sorted.
    pub fn blocked_ips(&self) -> Vec<IpAddr> {
        let mut ips: Vec<IpAddr> =
            self.failures.locked().iter().filter(|(_, n)| **n >= MAX_FAILURES).map(|(ip, _)| *ip).collect();
        ips.sort();
        ips
    }

    /// Checks `candidate` for `ip`, updating the blacklist atomically.
    pub fn login(&self, ip: IpAddr, candidate: &str) -> LoginResult {
        let mut failures = self.failures.locked();
        let count = failures.get(&ip).copied().unwrap_or(0);
        if count >= MAX_FAILURES {
            return LoginResult::Blocked { just_now: false };
        }
        let expected = *self.digest.read_ok();
        let matches: bool = sha256(candidate).ct_eq(&expected).into();
        if matches {
            failures.remove(&ip);
            drop(failures);
            let (id, token) = self.create_session();
            return LoginResult::Ok { id, token };
        }
        let count = count + 1;
        failures.insert(ip, count);
        if count >= MAX_FAILURES {
            LoginResult::Blocked { just_now: true }
        } else {
            LoginResult::Wrong { remaining: MAX_FAILURES - count }
        }
    }

    fn create_session(&self) -> (SessionId, String) {
        let id = SessionId(random::bytes::<16>());
        let secret = random::bytes::<32>();
        let token = format!("{}{}", random::hex(&id.0), random::hex(&secret));
        let mut sessions = self.sessions.locked();
        if sessions.len() >= MAX_SESSIONS
            && let Some(oldest) = sessions.iter().min_by_key(|(_, r)| r.last_ms).map(|(k, _)| *k)
        {
            sessions.remove(&oldest);
        }
        sessions.insert(id, SessionRecord { secret, last_ms: clock::unix_ms() });
        (id, token)
    }

    /// The session a cookie token belongs to, if it is valid.
    pub fn verify(&self, token: &str) -> Option<SessionId> {
        if token.len() != 96 {
            return None;
        }
        let id = SessionId(random::unhex::<16>(&token[..32])?);
        let secret = random::unhex::<32>(&token[32..])?;
        let mut sessions = self.sessions.locked();
        let record = sessions.get_mut(&id)?;
        if bool::from(record.secret.ct_eq(&secret)) {
            record.last_ms = clock::unix_ms();
            Some(id)
        } else {
            None
        }
    }

    /// Ends a session.
    pub fn logout(&self, id: SessionId) {
        self.sessions.locked().remove(&id);
    }

    /// Number of live sessions.
    pub fn session_count(&self) -> usize {
        self.sessions.locked().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn correct_password_creates_a_verifiable_session() {
        let auth = Auth::new("open sesame", PasswordSource::Cli);
        let LoginResult::Ok { id, token } = auth.login(ip("10.0.0.1"), "open sesame") else { panic!() };
        assert_eq!(token.len(), 96);
        assert_eq!(auth.verify(&token), Some(id));
        // Tampering with one character of the secret invalidates it.
        let mut bad = token.clone();
        let last = if bad.ends_with('0') { '1' } else { '0' };
        bad.pop();
        bad.push(last);
        assert_eq!(auth.verify(&bad), None);
        assert_eq!(auth.verify("short"), None);
        auth.logout(id);
        assert_eq!(auth.verify(&token), None);
    }

    #[test]
    fn three_failures_block_the_ip_until_restart() {
        let auth = Auth::new("pw", PasswordSource::Random);
        let a = ip("192.168.1.5");
        assert_eq!(auth.login(a, "x"), LoginResult::Wrong { remaining: 2 });
        assert_eq!(auth.login(a, "y"), LoginResult::Wrong { remaining: 1 });
        assert_eq!(auth.login(a, "z"), LoginResult::Blocked { just_now: true });
        assert!(auth.is_blocked(a));
        // Even the right password is refused now.
        assert_eq!(auth.login(a, "pw"), LoginResult::Blocked { just_now: false });
        // Other IPs are unaffected.
        assert!(matches!(auth.login(ip("192.168.1.6"), "pw"), LoginResult::Ok { .. }));
        assert_eq!(auth.blocked_ips(), vec![a]);
    }

    #[test]
    fn success_resets_the_failure_count() {
        let auth = Auth::new("pw", PasswordSource::Settings);
        let a = ip("::1");
        auth.login(a, "bad");
        auth.login(a, "bad");
        assert!(matches!(auth.login(a, "pw"), LoginResult::Ok { .. }));
        assert_eq!(auth.login(a, "bad"), LoginResult::Wrong { remaining: 2 });
    }

    #[test]
    fn parallel_attempts_never_exceed_the_limit() {
        let auth = Arc::new(Auth::new("pw", PasswordSource::Cli));
        let a = ip("10.9.9.9");
        let handles: Vec<_> = (0..32)
            .map(|_| {
                let auth = auth.clone();
                std::thread::spawn(move || auth.login(a, "wrong"))
            })
            .collect();
        let results: Vec<LoginResult> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let wrong = results.iter().filter(|r| matches!(r, LoginResult::Wrong { .. })).count();
        let blocked_now = results.iter().filter(|r| **r == LoginResult::Blocked { just_now: true }).count();
        assert_eq!(wrong, 2);
        assert_eq!(blocked_now, 1);
        assert!(auth.is_blocked(a));
    }

    #[test]
    fn changing_the_password_keeps_sessions() {
        let auth = Auth::new("old", PasswordSource::Random);
        let LoginResult::Ok { token, .. } = auth.login(ip("10.0.0.1"), "old") else { panic!() };
        auth.set_password("new", PasswordSource::Settings);
        assert!(auth.verify(&token).is_some());
        assert!(matches!(auth.login(ip("10.0.0.2"), "old"), LoginResult::Wrong { .. }));
        assert!(matches!(auth.login(ip("10.0.0.2"), "new"), LoginResult::Ok { .. }));
        assert_eq!(auth.password_source(), PasswordSource::Settings);
    }

    #[test]
    fn sessions_are_capped() {
        let auth = Auth::new("pw", PasswordSource::Cli);
        for _ in 0..MAX_SESSIONS + 10 {
            assert!(matches!(auth.login(ip("10.0.0.1"), "pw"), LoginResult::Ok { .. }));
        }
        assert_eq!(auth.session_count(), MAX_SESSIONS);
    }
}
