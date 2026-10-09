//! Console preparation: UTF-8 output and ANSI escape processing.
//!
//! Without `ENABLE_VIRTUAL_TERMINAL_PROCESSING` the Windows 10 conhost prints
//! raw escape bytes instead of colours, and without `SetConsoleOutputCP(CP_UTF8)`
//! the box-drawing and block characters in the banner come out as mojibake.

use super::ffi::*;
use super::wide;

/// Switch the console to UTF-8 and enable virtual-terminal (ANSI) processing.
/// Best-effort: on a redirected or unusual stdout the calls simply fail and we
/// carry on with whatever the terminal supports.
pub fn enable_ansi() {
    unsafe {
        SetConsoleOutputCP(CP_UTF8);
        let h = GetStdHandle(STD_OUTPUT_HANDLE);
        if !h.is_null() {
            let mut mode: DWORD = 0;
            if GetConsoleMode(h, &mut mode) != 0 {
                SetConsoleMode(
                    h,
                    mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING | ENABLE_PROCESSED_OUTPUT,
                );
            }
        }
    }
}

/// Set the console window title.
pub fn set_title(title: &str) {
    let w = wide(title);
    unsafe {
        SetConsoleTitleW(w.as_ptr());
    }
}

/// Make the process per-monitor-DPI-v2 aware so absolute cursor coordinates are
/// correct under display scaling and on multi-monitor setups. Best effort: on
/// older Windows the call simply fails and we fall back to system DPI.
pub fn set_dpi_aware() {
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}
