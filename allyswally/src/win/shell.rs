//! Open paths, URLs and executables on the host with `ShellExecuteW`.
//!
//! MASKED's "open/run" items use the shell `open` verb, which resolves the
//! right handler for a folder, a web URL or a binary alike, and honours file
//! associations. Opening the data directory in Explorer uses the same path.

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
