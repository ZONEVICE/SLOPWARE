//! Build script: stamps the build date into the binary as `BUILD_DATE`.
//!
//! No external tools and no dependencies — just the current UTC date computed
//! from the system clock, so the About screen and the console banner show when
//! the running `.exe` was compiled.

use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    println!("cargo:rustc-env=BUILD_DATE={}", date_string(days));
    // Rebuild when the web assets change so the embedded front end stays fresh.
    println!("cargo:rerun-if-changed=src/web");
}

/// Days-since-epoch to `YYYY-MM-DD` (Howard Hinnant's civil_from_days).
fn date_string(z: i64) -> String {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}
