//! User activity and the idle timeout.
//!
//! Tendril closes itself after `idle_timeout_minutes` without user activity
//! (three hours by default; at least one minute; it cannot be disabled, only
//! set very high). *Activity* means actions of a person: authenticated API
//! requests that the browser did not mark as automatic (`X-Tendril-Quiet`),
//! page loads, and keystrokes sent to a terminal. Heartbeats, status polls and
//! output produced by programs running in a terminal do **not** count;
//! otherwise a forgotten browser tab would keep the server alive forever.
//!
//! Time is wall-clock (Unix milliseconds) rather than monotonic: a monotonic
//! clock stops while a laptop sleeps, and hours of suspend should count as
//! inactivity. The watchdog that acts on [`Activity::expired`] lives in
//! `app.rs`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::core::clock;

/// Last activity timestamp and the configured timeout.
pub struct Activity {
    last_ms: AtomicU64,
    timeout_ms: AtomicU64,
    /// Wakes the watchdog when the timeout changes (it may now end sooner).
    changed: tokio::sync::Notify,
}

impl Activity {
    /// Starts the clock now with a timeout in minutes.
    pub fn new(timeout_minutes: u64) -> Activity {
        let activity = Activity {
            last_ms: AtomicU64::new(clock::unix_ms()),
            timeout_ms: AtomicU64::new(0),
            changed: tokio::sync::Notify::new(),
        };
        activity.set_timeout_minutes(timeout_minutes);
        activity
    }

    /// Records user activity now.
    pub fn touch(&self) {
        self.last_ms.fetch_max(clock::unix_ms(), Ordering::Relaxed);
    }

    /// Changes the timeout (minimum one minute).
    pub fn set_timeout_minutes(&self, minutes: u64) {
        self.set_timeout(Duration::from_secs(minutes.max(1).saturating_mul(60)));
    }

    /// Changes the timeout to an exact duration (tests use sub-minute values).
    pub fn set_timeout(&self, timeout: Duration) {
        self.timeout_ms.store(timeout.as_millis().min(u64::MAX as u128) as u64, Ordering::Relaxed);
        self.changed.notify_one();
    }

    /// Resolves after the next timeout change (one pending change is kept if
    /// nobody was waiting).
    pub async fn timeout_changed(&self) {
        self.changed.notified().await;
    }

    /// The configured timeout.
    pub fn timeout(&self) -> Duration {
        Duration::from_millis(self.timeout_ms.load(Ordering::Relaxed))
    }

    /// Time since the last activity.
    pub fn idle(&self) -> Duration {
        Duration::from_millis(clock::unix_ms().saturating_sub(self.last_ms.load(Ordering::Relaxed)))
    }

    /// Time left before the process closes itself.
    pub fn remaining(&self) -> Duration {
        self.timeout().saturating_sub(self.idle())
    }

    /// True once the idle time reached the timeout.
    pub fn expired(&self) -> bool {
        self.idle() >= self.timeout()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expires_after_the_timeout_and_touch_resets_it() {
        let activity = Activity::new(180);
        assert_eq!(activity.timeout(), Duration::from_secs(180 * 60));
        assert!(!activity.expired());
        activity.set_timeout(Duration::from_millis(30));
        std::thread::sleep(Duration::from_millis(50));
        assert!(activity.expired());
        assert_eq!(activity.remaining(), Duration::ZERO);
        activity.touch();
        assert!(!activity.expired());
    }

    #[test]
    fn the_minimum_is_one_minute() {
        let activity = Activity::new(0);
        assert_eq!(activity.timeout(), Duration::from_secs(60));
    }

    #[test]
    fn huge_timeouts_do_not_overflow() {
        let activity = Activity::new(u64::MAX);
        assert!(!activity.expired());
        assert!(activity.remaining() > Duration::from_secs(1_000_000));
    }
}
