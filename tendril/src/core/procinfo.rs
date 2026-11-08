//! The process's resident memory, for the Settings tab and the docs' RAM
//! measurements: `VmRSS` from `/proc/self/status` on Linux, the working set
//! from `K32GetProcessMemoryInfo` (kernel32, Windows 7+) on Windows.

/// Resident set size in bytes, when the platform exposes it.
pub fn resident_bytes() -> Option<u64> {
    platform_resident_bytes()
}

#[cfg(target_os = "linux")]
fn platform_resident_bytes() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmRSS:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib * 1024)
}

#[cfg(windows)]
fn platform_resident_bytes() -> Option<u64> {
    use std::ffi::c_void;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct ProcessMemoryCounters {
        cb: u32,
        PageFaultCount: u32,
        PeakWorkingSetSize: usize,
        WorkingSetSize: usize,
        QuotaPeakPagedPoolUsage: usize,
        QuotaPagedPoolUsage: usize,
        QuotaPeakNonPagedPoolUsage: usize,
        QuotaNonPagedPoolUsage: usize,
        PagefileUsage: usize,
        PeakPagefileUsage: usize,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn K32GetProcessMemoryInfo(process: *mut c_void, counters: *mut ProcessMemoryCounters, cb: u32) -> i32;
    }

    let mut counters: ProcessMemoryCounters = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
    // SAFETY: the struct matches PROCESS_MEMORY_COUNTERS and `cb` holds its
    // size; GetCurrentProcess returns a pseudo-handle that needs no closing.
    let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
    if ok == 0 { None } else { Some(counters.WorkingSetSize as u64) }
}

#[cfg(not(any(target_os = "linux", windows)))]
fn platform_resident_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn reports_something_plausible() {
        if let Some(bytes) = super::resident_bytes() {
            assert!(bytes > 100 * 1024 && bytes < 64 * 1024 * 1024 * 1024);
        }
    }
}
