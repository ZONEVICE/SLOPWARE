//! Clocks and calendar arithmetic, without a date library.
//!
//! Three needs: epoch milliseconds (every timestamp on the wire and in the
//! interface), ISO 8601 stamps for log lines, and the broken-down UTC time a
//! certificate's validity period is written in.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch, like JavaScript's `Date.now()`.
pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_millis() as i64,
        Err(before) => -(before.duration().as_millis() as i64),
    }
}

/// JavaScript's `Math.round`: halves round towards positive infinity.
pub fn js_round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// An entry's modification time in whole milliseconds, computed exactly the
/// way Node.js computes `Math.round(stats.mtimeMs)`.
///
/// Node builds `mtimeMs` as `seconds * 1e3 + nanoseconds / 1e6` in double
/// precision and Reptile rounds it. Doing the same arithmetic (rather than an
/// exact integer division) keeps the two implementations in agreement even for
/// sub-millisecond timestamps that sit right on a rounding boundary.
pub fn mtime_ms(time: SystemTime) -> i64 {
    let (seconds, nanos) = match time.duration_since(UNIX_EPOCH) {
        Ok(after) => (after.as_secs() as f64, after.subsec_nanos() as f64),
        Err(before) => {
            // Before 1970: split like a timespec (negative seconds, positive nanoseconds).
            let duration = before.duration();
            let mut seconds = -(duration.as_secs() as f64);
            let mut nanos = duration.subsec_nanos() as f64;
            if nanos > 0.0 {
                seconds -= 1.0;
                nanos = 1_000_000_000.0 - nanos;
            }
            (seconds, nanos)
        }
    };
    js_round(seconds * 1e3 + nanos / 1e6) as i64
}

/// The `SystemTime` for an epoch-milliseconds value.
pub fn system_time(ms: i64) -> SystemTime {
    if ms >= 0 {
        UNIX_EPOCH + Duration::from_millis(ms as u64)
    } else {
        UNIX_EPOCH - Duration::from_millis(ms.unsigned_abs())
    }
}

/// Broken-down UTC time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Utc {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub millis: u32,
}

/// Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Split epoch milliseconds into UTC fields.
pub fn utc(ms: i64) -> Utc {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    Utc {
        year,
        month,
        day,
        hour: (rest / 3_600_000) as u32,
        minute: (rest / 60_000 % 60) as u32,
        second: (rest / 1000 % 60) as u32,
        millis: (rest % 1000) as u32,
    }
}

/// `2026-10-07T21:05:09.123Z`, like JavaScript's `toISOString()`.
pub fn iso_timestamp(ms: i64) -> String {
    let t = utc(ms);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", t.year, t.month, t.day, t.hour, t.minute, t.second, t.millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_javascript() {
        assert_eq!(iso_timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_timestamp(1_791_433_309_987), "2026-10-08T04:21:49.987Z");
        assert_eq!(iso_timestamp(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_timestamp(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn rounding_follows_math_round() {
        assert_eq!(js_round(1.5), 2.0);
        assert_eq!(js_round(-1.5), -1.0);
        assert_eq!(js_round(2.4999), 2.0);
        let time = UNIX_EPOCH + Duration::new(1_696_712_345, 678_500_000);
        assert_eq!(mtime_ms(time), 1_696_712_345_679);
        let exact = system_time(1_696_712_345_123);
        assert_eq!(mtime_ms(exact), 1_696_712_345_123);
    }
}
