//! Power and session actions, plus the host battery reading.
//!
//! Shutdown and reboot need `SeShutdownPrivilege`, which we enable on the
//! process token first. Monitor-off is a broadcast `WM_SYSCOMMAND`. All of
//! these are wired to hold-to-confirm controls in the UI and are logged.

use super::ffi::*;
use super::wide;
use std::mem::size_of;

/// Battery snapshot from `GetSystemPowerStatus`. Values use the Win32
/// sentinels: 255 means "unknown" for the percentage, and `u32::MAX` means
/// "unknown" for the time estimates.
#[derive(Clone, Copy, Default)]
pub struct PowerStatus {
    pub ac_line: u8,       // 0 offline, 1 online, 255 unknown
    pub battery_flag: u8,  // bitfield; 128 = no system battery
    pub percent: u8,       // 0..=100, or 255 unknown
    pub seconds_left: u32, // u32::MAX unknown
}

pub fn power_status() -> Option<PowerStatus> {
    let mut s = SYSTEM_POWER_STATUS::default();
    let ok = unsafe { GetSystemPowerStatus(&mut s) };
    if ok == 0 {
        return None;
    }
    Some(PowerStatus {
        ac_line: s.ACLineStatus,
        battery_flag: s.BatteryFlag,
        percent: s.BatteryLifePercent,
        seconds_left: s.BatteryLifeTime,
    })
}

/// Lock the current session (Win+L equivalent).
pub fn lock() -> bool {
    unsafe { LockWorkStation() != 0 }
}

/// Turn the monitor off to save power while controlling the host remotely.
pub fn monitor_off() {
    unsafe {
        SendMessageW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, MONITOR_OFF);
    }
}

/// Enter sleep (suspend). Hibernate is not requested. `SetSuspendState` is
/// resolved from powrprof.dll at runtime because the mingw sysroot has no
/// import library for it.
pub fn suspend() -> bool {
    let dll = wide("powrprof.dll");
    unsafe {
        let module = LoadLibraryW(dll.as_ptr());
        if module.is_null() {
            return false;
        }
        let name = b"SetSuspendState\0";
        let proc = GetProcAddress(module, name.as_ptr());
        if proc.is_null() {
            return false;
        }
        let func: SetSuspendStateFn = std::mem::transmute(proc);
        func(FALSE, FALSE, FALSE) != 0
    }
}

/// Enable `SeShutdownPrivilege` on the current process token so `ExitWindowsEx`
/// is permitted. Returns false if the privilege cannot be acquired.
fn enable_shutdown_privilege() -> bool {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        ) == 0
        {
            return false;
        }
        let name = wide("SeShutdownPrivilege");
        let mut luid = LUID {
            LowPart: 0,
            HighPart: 0,
        };
        let got = LookupPrivilegeValueW(std::ptr::null(), name.as_ptr(), &mut luid);
        if got == 0 {
            CloseHandle(token);
            return false;
        }
        let tp = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        let ok = AdjustTokenPrivileges(
            token,
            FALSE,
            &tp,
            size_of::<TOKEN_PRIVILEGES>() as DWORD,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        CloseHandle(token);
        // AdjustTokenPrivileges can return success yet not assign all
        // privileges; check GetLastError.
        ok != 0 && GetLastError() == ERROR_SUCCESS
    }
}

/// Reboot the host. Requires the shutdown privilege (hence elevation in
/// practice). `force` closes unresponsive apps.
pub fn reboot(force: bool) -> bool {
    if !enable_shutdown_privilege() {
        return false;
    }
    let mut flags = EWX_REBOOT;
    if force {
        flags |= EWX_FORCEIFHUNG;
    }
    unsafe { ExitWindowsEx(flags, SHTDN_REASON_FLAG_PLANNED) != 0 }
}

/// Power the host off.
pub fn shutdown(force: bool) -> bool {
    if !enable_shutdown_privilege() {
        return false;
    }
    let mut flags = EWX_SHUTDOWN | EWX_POWEROFF;
    if force {
        flags |= EWX_FORCEIFHUNG;
    }
    unsafe { ExitWindowsEx(flags, SHTDN_REASON_FLAG_PLANNED) != 0 }
}
