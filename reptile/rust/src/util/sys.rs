//! The few operating-system facts the standard library does not expose: the
//! host name, the home and per-user data directories, and a way to wait for
//! Ctrl+C / SIGTERM.

use std::path::{Path, PathBuf};

/// This computer's host name, as Node.js's `os.hostname()` reports it.
#[cfg(unix)]
pub fn hostname() -> String {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer is valid for its whole length.
    let result = unsafe { libc::gethostname(buffer.as_mut_ptr() as *mut libc::c_char, buffer.len()) };
    if result != 0 {
        return "localhost".into();
    }
    let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
    String::from_utf8_lossy(&buffer[..end]).into_owned()
}

#[cfg(windows)]
pub fn hostname() -> String {
    // The DNS host name, which is what Node.js reports too (libuv asks
    // GetHostNameW; this call answers the same and exists on every Windows).
    use windows_sys::Win32::System::SystemInformation::{ComputerNamePhysicalDnsHostname, GetComputerNameExW};
    let mut buffer = [0u16; 256];
    let mut size = buffer.len() as u32;
    // SAFETY: `size` tells the call how many UTF-16 units it may write.
    let ok = unsafe { GetComputerNameExW(ComputerNamePhysicalDnsHostname, buffer.as_mut_ptr(), &mut size) };
    if ok == 0 || size == 0 {
        return std::env::var("COMPUTERNAME").unwrap_or_else(|_| "localhost".into());
    }
    String::from_utf16_lossy(&buffer[..size as usize])
}

#[cfg(not(any(unix, windows)))]
pub fn hostname() -> String {
    "localhost".into()
}

/// The user's home directory (`$HOME`, or `%USERPROFILE%` on Windows).
pub fn home_dir() -> PathBuf {
    let candidates: &[&str] = if cfg!(windows) { &["USERPROFILE", "HOME"] } else { &["HOME"] };
    for name in candidates {
        if let Some(value) = std::env::var_os(name).filter(|v| !v.is_empty()) {
            return PathBuf::from(value);
        }
    }
    if cfg!(windows) {
        PathBuf::from(r"C:\")
    } else {
        PathBuf::from("/")
    }
}

/// Where per-user application data lives: `$XDG_DATA_HOME/reptile` or
/// `~/.local/share/reptile` on Linux, `%LOCALAPPDATA%\Reptile` on Windows.
pub fn data_dir() -> PathBuf {
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()) {
            return PathBuf::from(local).join("Reptile");
        }
        return home_dir().join("AppData").join("Local").join("Reptile");
    }
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        let xdg = PathBuf::from(xdg);
        if xdg.is_absolute() {
            return xdg.join("reptile");
        }
    }
    home_dir().join(".local").join("share").join("reptile")
}

/// Strip the `\\?\` prefix `canonicalize` adds on Windows, so paths look like
/// the ones the user typed (and like Node's `fs.realpath`).
pub fn display_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// `fs.realpath`: the canonical path, without Windows' verbatim prefix.
pub fn real_path(path: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path).map(|canonical| display_path(&canonical))
}

/// Block until the process is asked to stop (Ctrl+C, SIGTERM, closing the
/// console window), then call `on_stop` once.
#[cfg(unix)]
pub fn on_termination(on_stop: impl FnOnce(&'static str) + Send + 'static) {
    // Must run before other threads exist: they inherit the blocked mask, so
    // the signals are delivered to the waiting thread alone.
    // SAFETY: plain POSIX signal mask manipulation.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        let waiter_set = set;
        std::thread::Builder::new()
            .name("signals".into())
            .spawn(move || {
                let mut signal: libc::c_int = 0;
                libc::sigwait(&waiter_set, &mut signal);
                on_stop(if signal == libc::SIGTERM { "SIGTERM" } else { "SIGINT" });
            })
            .expect("spawn the signal thread");
    }
}

#[cfg(windows)]
pub fn on_termination(on_stop: impl FnOnce(&'static str) + Send + 'static) {
    use crate::util::threads::Locked;
    use std::sync::Mutex;
    use windows_sys::core::BOOL;
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;

    type StopCallback = Box<dyn FnOnce(&'static str) + Send>;
    static HANDLER: Mutex<Option<StopCallback>> = Mutex::new(None);
    *HANDLER.locked() = Some(Box::new(on_stop));

    unsafe extern "system" fn handler(kind: u32) -> BOOL {
        let name = if kind == 0 { "SIGINT" } else { "SIGTERM" };
        let callback = HANDLER.locked().take();
        if let Some(callback) = callback {
            // Windows runs this on its own thread and ends the process when
            // it returns for a close event: do the work right here.
            callback(name);
        }
        1
    }
    // SAFETY: registers a plain function pointer.
    unsafe {
        SetConsoleCtrlHandler(Some(handler), 1);
    }
}

#[cfg(not(any(unix, windows)))]
pub fn on_termination(_on_stop: impl FnOnce(&'static str) + Send + 'static) {}

#[cfg(unix)]
/// `access(2)`: whether the current user may read/write/traverse `path`.
pub fn access(path: &Path, read: bool, write: bool, execute: bool) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return false };
    let mut mode = 0;
    if read {
        mode |= libc::R_OK;
    }
    if write {
        mode |= libc::W_OK;
    }
    if execute {
        mode |= libc::X_OK;
    }
    // SAFETY: a valid NUL-terminated path.
    unsafe { libc::access(c_path.as_ptr(), mode) == 0 }
}

#[cfg(not(unix))]
/// Windows has no execute bit and no meaningful read-only flag on
/// directories; like Node's `fs.access`, only existence (and, for files, the
/// read-only attribute) is checked.
pub fn access(path: &Path, _read: bool, write: bool, _execute: bool) -> bool {
    match std::fs::metadata(path) {
        Ok(meta) => !(write && meta.is_file() && meta.permissions().readonly()),
        Err(_) => false,
    }
}
