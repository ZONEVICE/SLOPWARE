//! Wall-clock helpers and civil-date formatting.
//!
//! Tendril avoids a date/time crate: it only needs UTC timestamps for the logs
//! (RFC 3339), the date part for daily log file names, and the HTTP date
//! format for `Last-Modified`. All of them derive from Unix time with Howard
//! Hinnant's `civil_from_days` algorithm. Everything is UTC on purpose: local
//! time zones would need the tz database.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch (0 if the clock is before 1970).
pub fn unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Milliseconds since the Unix epoch for an arbitrary `SystemTime`.
pub fn system_time_ms(time: SystemTime) -> u64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as u64,
        Err(_) => 0,
    }
}

/// `SystemTime` for a number of milliseconds since the Unix epoch.
pub fn ms_to_system_time(ms: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(ms)
}

/// Converts days since 1970-01-01 to a proleptic Gregorian (year, month, day).
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (inverse of
/// [`civil_from_days`]).
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The UTC day number (days since the epoch) of a Unix timestamp in ms.
pub fn day_number(unix_ms: u64) -> i64 {
    (unix_ms / 86_400_000) as i64
}

/// `YYYY-MM-DD` for a day number.
pub fn date_string(day: i64) -> String {
    let (y, m, d) = civil_from_days(day);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Parses `YYYY-MM-DD` back into a day number.
pub fn parse_date(text: &str) -> Option<i64> {
    let mut parts = text.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    let d: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

/// RFC 3339 UTC timestamp with milliseconds: `2026-10-14T12:34:56.789Z`.
pub fn rfc3339_ms(unix_ms: u64) -> String {
    let secs = unix_ms / 1000;
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, (rem % 3600) / 60, rem % 60, unix_ms % 1000)
}

/// IMF-fixdate used by HTTP headers: `Tue, 14 Oct 2026 12:34:56 GMT`.
pub fn http_date(unix_ms: u64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let secs = unix_ms / 1000;
    let days = (secs / 86_400) as i64;
    let (y, m, d) = civil_from_days(days);
    let rem = secs % 86_400;
    format!(
        "{}, {d:02} {} {y:04} {:02}:{:02}:{:02} GMT",
        DAYS[(days.rem_euclid(7)) as usize],
        MONTHS[(m - 1) as usize],
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trip_over_a_wide_range() {
        for day in (-800_000..800_000).step_by(997) {
            let (y, m, d) = civil_from_days(day);
            assert_eq!(days_from_civil(y, m, d), day);
        }
    }

    #[test]
    fn known_dates() {
        assert_eq!(date_string(0), "1970-01-01");
        assert_eq!(date_string(day_number(1_791_979_200_000)), "2026-10-14");
        assert_eq!(parse_date("2026-10-14"), Some(day_number(1_791_979_200_000)));
        assert_eq!(parse_date("2026-13-01"), None);
        assert_eq!(parse_date("garbage"), None);
    }

    #[test]
    fn rfc3339_and_http_date() {
        // 2026-10-14T12:00:00.123Z
        let ms = 1_791_979_200_123;
        assert_eq!(rfc3339_ms(ms), "2026-10-14T12:00:00.123Z");
        assert_eq!(http_date(ms), "Wed, 14 Oct 2026 12:00:00 GMT");
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
    }
}
