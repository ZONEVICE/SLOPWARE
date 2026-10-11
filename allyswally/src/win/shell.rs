//! Open paths, URLs and executables on the host with `ShellExecuteW`.
//!
//! MASKED's "open/run" items use the shell `open` verb, which resolves the
//! right handler for a folder, a web URL or a binary alike, and honours file
//! associations. Opening the data directory in Explorer uses the same path.
//!
//! The `runas` verb (via `ShellExecuteExW`, which hands back a process handle)
//! relaunches AllySwally elevated for the one-off firewall fix.

use super::ffi::*;
use super::wide;

const SW_SHOWNORMAL: i32 = 1;

/// Ask the shell to open `target` (a path, URL or executable), optionally with
/// `args`. Returns true if the shell accepted the request. The return value of
/// `ShellExecuteW` is an `HINSTANCE`-shaped error code: values greater than 32
/// mean success.
pub fn open(target: &str, args: Option<&str>) -> bool {
    let verb = wide("open");
    let file = wide(target);
    let params = args.map(wide);
    let params_ptr = params
        .as_ref()
        .map(|v| v.as_ptr())
        .unwrap_or(std::ptr::null());
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            params_ptr,
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    (result as usize) > 32
}

/// How an elevated relaunch ended.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Elevated {
    /// The elevated process ran and exited with this code.
    Exited(u32),
    /// The user answered "No" on the UAC prompt.
    Declined,
    /// It started but was still running when the wait ran out.
    TimedOut,
    /// The shell could not start it (Win32 error code).
    Failed(u32),
}

/// Run `program` with administrator rights (the `runas` verb, so Windows shows
/// the UAC prompt) and a hidden window, then wait up to `timeout_ms` for it to
/// exit. Blocks while the prompt is on screen.
pub fn run_elevated(program: &str, params: &str, timeout_ms: u32) -> Elevated {
    let verb = wide("runas");
    let file = wide(program);
    let params = wide(params);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as DWORD,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        hwnd: std::ptr::null_mut(),
        lpVerb: verb.as_ptr(),
        lpFile: file.as_ptr(),
        lpParameters: params.as_ptr(),
        lpDirectory: std::ptr::null(),
        nShow: SW_HIDE,
        hInstApp: std::ptr::null_mut(),
        lpIDList: std::ptr::null_mut(),
        lpClass: std::ptr::null(),
        hkeyClass: std::ptr::null_mut(),
        dwHotKey: 0,
        hIconOrMonitor: std::ptr::null_mut(),
        hProcess: std::ptr::null_mut(),
    };
    unsafe {
        if ShellExecuteExW(&mut info) == 0 {
            return match GetLastError() {
                ERROR_CANCELLED => Elevated::Declined,
                code => Elevated::Failed(code),
            };
        }
        if info.hProcess.is_null() {
            // The shell handed the request off without a process handle; there
            // is nothing to wait on.
            return Elevated::TimedOut;
        }
        let outcome = if WaitForSingleObject(info.hProcess, timeout_ms) == WAIT_OBJECT_0 {
            let mut code: DWORD = 0;
            if GetExitCodeProcess(info.hProcess, &mut code) != 0 {
                Elevated::Exited(code)
            } else {
                Elevated::Failed(GetLastError())
            }
        } else {
            Elevated::TimedOut
        };
        CloseHandle(info.hProcess);
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_pointer_width = "64")]
    fn shellexecuteinfo_layout_matches_win64() {
        assert_eq!(std::mem::size_of::<SHELLEXECUTEINFOW>(), 112);
    }

    /// Shows a real UAC prompt unless the test runner is already elevated, so
    /// it only runs on request: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn elevated_child_exit_code_is_reported() {
        assert_eq!(run_elevated("cmd.exe", "/c exit 7", 30_000), Elevated::Exited(7));
    }
}
