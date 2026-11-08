//! Poison-tolerant locking.
//!
//! A `std::sync::Mutex` becomes "poisoned" when a thread panics while holding
//! it. Release builds abort on panic, so poisoning can only be observed in
//! debug builds and tests; there, recovering the guard is always preferable to
//! cascading the panic into every later request.

use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// Extension for `Mutex` that ignores poisoning.
pub trait LockExt<T> {
    /// Lock the mutex, recovering the data if a previous holder panicked.
    fn locked(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn locked(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Extension for `RwLock` that ignores poisoning.
pub trait RwLockExt<T> {
    /// Shared access, recovering the data if a previous writer panicked.
    fn read_ok(&self) -> RwLockReadGuard<'_, T>;
    /// Exclusive access, recovering the data if a previous writer panicked.
    fn write_ok(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T> RwLockExt<T> for RwLock<T> {
    fn read_ok(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write_ok(&self) -> RwLockWriteGuard<'_, T> {
        self.write().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
