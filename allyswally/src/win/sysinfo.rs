//! Host identity and uptime.
//!
//! Computer name via `GetComputerNameExW`, Windows version via `RtlGetVersion`
//! (which, unlike `GetVersionEx`, is not subject to the compatibility manifest
//! shim and reports the real build), and uptime via `GetTickCount64`.

use super::ffi::*;
use super::from_wide;

/// The host's physical DNS host name.
pub fn computer_name() -> String {
    let mut size: DWORD = 0;
    unsafe {
        // First call with a null buffer to learn the required size.
        GetComputerNameExW(ComputerNamePhysicalDnsHostname, std::ptr::null_mut(), &mut size);
        if size == 0 {
            return String::from("unknown");
        }
        let mut buf = vec![0u16; size as usize];
        if GetComputerNameExW(ComputerNamePhysicalDnsHostname, buf.as_mut_ptr(), &mut size) == 0 {
            return String::from("unknown");
        }
        from_wide(&buf)
    }
}

/// Windows version as `(major, minor, build)`.
pub fn windows_version() -> (u32, u32, u32) {
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as DWORD,
        ..Default::default()
    };
    unsafe {
        if RtlGetVersion(&mut info) == 0 {
            (info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber)
        } else {
            (0, 0, 0)
        }
    }
}

/// A friendly Windows name derived from the version numbers. Windows 11 keeps
/// major version 10 but has build >= 22000.
pub fn windows_label() -> String {
    let (major, minor, build) = windows_version();
    let family = if major == 10 && build >= 22000 {
        "Windows 11"
    } else if major == 10 {
        "Windows 10"
    } else if major == 6 {
        "Windows (legacy)"
    } else {
        "Windows"
    };
    format!("{family} (build {build}.{major}.{minor})")
}

/// Milliseconds since the host booted.
pub fn uptime_millis() -> u64 {
    unsafe { GetTickCount64() }
}

/// Local wall-clock time, used for log file names and timestamps so they match
/// the day the user actually sees on the host.
#[derive(Clone, Copy)]
pub struct LocalTime {
    pub year: u16,
    pub month: u16,
    pub day: u16,
    pub hour: u16,
    pub minute: u16,
    pub second: u16,
    pub millis: u16,
}

pub fn local_time() -> LocalTime {
    let mut st = SYSTEMTIME::default();
    unsafe {
        GetLocalTime(&mut st);
    }
    LocalTime {
        year: st.wYear,
        month: st.wMonth,
        day: st.wDay,
        hour: st.wHour,
        minute: st.wMinute,
        second: st.wSecond,
        millis: st.wMilliseconds,
    }
}

impl LocalTime {
    /// `YYYY-MM-DD`, used for the daily log file name.
    pub fn date(&self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }

    /// `YYYY-MM-DDTHH:MM:SS.mmm`, the log line timestamp.
    pub fn timestamp(&self) -> String {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}",
            self.year, self.month, self.day, self.hour, self.minute, self.second, self.millis
        )
    }

    /// `YYYY-MM-DD_HH-MM-SS`, safe for a backup directory name.
    pub fn stamp_for_filename(&self) -> String {
        format!(
            "{:04}-{:02}-{:02}_{:02}-{:02}-{:02}",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }
}
