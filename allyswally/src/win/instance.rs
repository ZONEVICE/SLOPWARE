//! Single-instance guard via a named Windows mutex.
//!
//! Holding one named mutex for the lifetime of the process lets a second
//! launch detect the first and exit cleanly instead of fighting over the port
//! and the data directory.

use super::ffi::*;
use super::wide;

/// A named mutex kept alive for as long as this value lives. Dropping it (at
/// process exit) releases the name.
pub struct SingleInstance {
    handle: HANDLE,
}

impl SingleInstance {
    /// Acquire the named mutex. Returns `Err(())` if another instance already
    /// holds it.
    pub fn acquire(name: &str) -> Result<SingleInstance, ()> {
        let wname = wide(name);
        unsafe {
            let handle = CreateMutexW(std::ptr::null_mut(), TRUE, wname.as_ptr());
            let already = GetLastError() == ERROR_ALREADY_EXISTS;
            if handle.is_null() || already {
                if !handle.is_null() {
                    CloseHandle(handle);
                }
                return Err(());
            }
            Ok(SingleInstance { handle })
        }
    }
}

impl Drop for SingleInstance {
    fn drop(&mut self) {
        unsafe {
            if !self.handle.is_null() {
                CloseHandle(self.handle);
            }
        }
    }
}

// The handle is only ever closed on drop; sharing the guard across threads is
// safe because we never touch the handle again after construction.
unsafe impl Send for SingleInstance {}
unsafe impl Sync for SingleInstance {}
