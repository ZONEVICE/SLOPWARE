//! Process elevation check.
//!
//! Without elevation Windows UIPI silently drops injected input aimed at
//! windows running at a higher integrity level (Task Manager, apps launched as
//! admin) and the UAC secure desktop is unreachable either way. The banner and
//! the Settings tab surface this so the user understands the limitation.

use super::ffi::*;
use std::ffi::c_void;
use std::mem::size_of;

/// True when the current process runs with an elevated token (Administrator).
pub fn is_elevated() -> bool {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut elevation: DWORD = 0;
        let mut ret_len: DWORD = 0;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            &mut elevation as *mut DWORD as *mut c_void,
            size_of::<DWORD>() as DWORD,
            &mut ret_len,
        );
        CloseHandle(token);
        ok != 0 && elevation != 0
    }
}
