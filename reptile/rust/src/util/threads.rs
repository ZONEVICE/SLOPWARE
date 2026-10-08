//! Small concurrency primitives on top of std threads.
//!
//! Synchronisation is where a sync tool earns or loses its correctness, so
//! these are deliberately boring: a serial queue, a cancellable timer, a
//! wakeable sleep, and a bounded worker pool.

use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

/// `Mutex::lock` that survives a poisoned lock.
///
/// A panic while a lock is held must not turn every later use of that lock
/// into another panic: the engine would stop syncing silently. The state
/// behind the lock may be stale, which the next reconciliation repairs.
pub trait Locked<T> {
    fn locked(&self) -> MutexGuard<'_, T>;
}

impl<T> Locked<T> for Mutex<T> {
    fn locked(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Spawn a named thread; a panic inside it is contained to that thread.
pub fn spawn(name: &str, work: impl FnOnce() + Send + 'static) {
    let _ = thread::Builder::new().name(name.to_string()).spawn(move || {
        let _ = catch_unwind(AssertUnwindSafe(work));
    });
}

// --- Wakeable sleep ----------------------------------------------------------------

/// A sleep that another thread can cut short (`wake`) or end for good (`stop`).
#[derive(Default)]
pub struct Sleeper {
    state: Mutex<(bool, u64)>,
    signal: Condvar,
}

impl Sleeper {
    pub fn new() -> Arc<Sleeper> {
        Arc::new(Sleeper::default())
    }

    /// Sleep for `duration`. Returns false once `stop` was called.
    pub fn sleep(&self, duration: Duration) -> bool {
        let deadline = Instant::now() + duration;
        let mut guard = self.state.locked();
        let wakes = guard.1;
        while !guard.0 && guard.1 == wakes {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            guard =
                self.signal.wait_timeout(guard, deadline - now).unwrap_or_else(std::sync::PoisonError::into_inner).0;
        }
        !guard.0
    }

    /// End the current sleep early (the sleeper keeps running).
    pub fn wake(&self) {
        self.state.locked().1 += 1;
        self.signal.notify_all();
    }

    /// End every sleep, now and in the future.
    pub fn stop(&self) {
        self.state.locked().0 = true;
        self.signal.notify_all();
    }

    pub fn stopped(&self) -> bool {
        self.state.locked().0
    }
}

// --- One-shot timer ----------------------------------------------------------------

/// A pending call; dropping the handle does NOT cancel it, `cancel` does.
#[derive(Clone)]
pub struct Timer {
    sleeper: Arc<Sleeper>,
    fired: Arc<AtomicBool>,
}

impl Timer {
    /// Run `work` on its own thread after `delay`, unless cancelled first.
    pub fn after(delay: Duration, work: impl FnOnce() + Send + 'static) -> Timer {
        let sleeper = Sleeper::new();
        let fired = Arc::new(AtomicBool::new(false));
        let timer = Timer { sleeper: sleeper.clone(), fired: fired.clone() };
        spawn("timer", move || {
            if sleeper.sleep(delay) && !fired.swap(true, Ordering::SeqCst) {
                work();
            }
        });
        timer
    }

    /// Cancel the call if it has not started yet.
    pub fn cancel(&self) {
        self.fired.store(true, Ordering::SeqCst);
        self.sleeper.stop();
    }
}

/// Run `work` every `period` on its own thread until `stop` on the returned
/// sleeper. The first call happens after one period.
pub fn every(name: &str, period: Duration, mut work: impl FnMut() + Send + 'static) -> Arc<Sleeper> {
    let sleeper = Sleeper::new();
    let handle = sleeper.clone();
    spawn(name, move || {
        while handle.sleep(period) {
            work();
        }
    });
    sleeper
}

/// Exponential backoff: base * 2^attempt, capped.
pub fn backoff_delay(attempt: u32, base_ms: u64, max_ms: u64) -> u64 {
    base_ms.saturating_mul(1u64 << attempt.min(30)).min(max_ms)
}

// --- Serial queue -------------------------------------------------------------------

type Task = Box<dyn FnOnce() + Send>;

struct QueueState {
    pending: VecDeque<Task>,
    running: bool,
    closed: bool,
}

/// Runs tasks one at a time, in submission order, on one worker thread.
///
/// IMPORTANT: a task must never wait for another task of its own queue; it
/// would wait for itself forever. Schedule and move on instead.
pub struct SerialQueue {
    state: Mutex<QueueState>,
    signal: Condvar,
}

impl SerialQueue {
    pub fn new(name: &str) -> Arc<SerialQueue> {
        let queue = Arc::new(SerialQueue {
            state: Mutex::new(QueueState { pending: VecDeque::new(), running: false, closed: false }),
            signal: Condvar::new(),
        });
        let worker = queue.clone();
        spawn(name, move || worker.work());
        queue
    }

    fn work(&self) {
        loop {
            let task = {
                let mut state = self.state.locked();
                state.running = false;
                self.signal.notify_all();
                loop {
                    if let Some(task) = state.pending.pop_front() {
                        state.running = true;
                        break task;
                    }
                    if state.closed {
                        return;
                    }
                    state = self.signal.wait(state).unwrap_or_else(std::sync::PoisonError::into_inner);
                }
            };
            let _ = catch_unwind(AssertUnwindSafe(task));
        }
    }

    pub fn push(&self, task: impl FnOnce() + Send + 'static) {
        let mut state = self.state.locked();
        if state.closed {
            return;
        }
        state.pending.push_back(Box::new(task));
        self.signal.notify_all();
    }

    /// Drop every task that has not started yet.
    pub fn clear(&self) {
        self.state.locked().pending.clear();
        self.signal.notify_all();
    }

    /// Wait until nothing is running or pending, at most `timeout`.
    pub fn idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.locked();
        while state.running || !state.pending.is_empty() {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            state =
                self.signal.wait_timeout(state, deadline - now).unwrap_or_else(std::sync::PoisonError::into_inner).0;
        }
        true
    }

    /// Stop the worker once the current task ends; pending tasks are dropped.
    pub fn close(&self) {
        let mut state = self.state.locked();
        state.closed = true;
        state.pending.clear();
        self.signal.notify_all();
    }
}

// --- Worker pool --------------------------------------------------------------------

/// Process `items` with at most `limit` threads. Failures are collected, never
/// thrown, so one failed transfer does not abandon the rest.
pub fn run_pool<T: Sync, E: Send>(
    items: &[T],
    limit: usize,
    stop: &(dyn Fn() -> bool + Sync),
    work: &(dyn Fn(&T) -> Result<(), E> + Sync),
) -> Vec<(usize, E)> {
    if items.is_empty() {
        return Vec::new();
    }
    let next = AtomicUsize::new(0);
    let failures = Mutex::new(Vec::new());
    let lanes = limit.max(1).min(items.len());
    thread::scope(|scope| {
        for _ in 0..lanes {
            scope.spawn(|| loop {
                if stop() {
                    return;
                }
                let index = next.fetch_add(1, Ordering::SeqCst);
                if index >= items.len() {
                    return;
                }
                if let Err(error) = work(&items[index]) {
                    failures.locked().push((index, error));
                }
            });
        }
    });
    failures.into_inner().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_runs_in_order_and_clears() {
        let queue = SerialQueue::new("test-queue");
        let seen = Arc::new(Mutex::new(Vec::new()));
        for index in 0..5 {
            let seen = seen.clone();
            queue.push(move || {
                thread::sleep(Duration::from_millis(5));
                seen.locked().push(index);
            });
        }
        assert!(queue.idle(Duration::from_secs(5)));
        assert_eq!(*seen.locked(), vec![0, 1, 2, 3, 4]);
        queue.close();
    }

    #[test]
    fn timers_fire_and_cancel() {
        let hits = Arc::new(AtomicUsize::new(0));
        let a = hits.clone();
        Timer::after(Duration::from_millis(10), move || {
            a.fetch_add(1, Ordering::SeqCst);
        });
        let b = hits.clone();
        let cancelled = Timer::after(Duration::from_millis(30), move || {
            b.fetch_add(10, Ordering::SeqCst);
        });
        cancelled.cancel();
        thread::sleep(Duration::from_millis(80));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert_eq!(backoff_delay(0, 1000, 10_000), 1000);
        assert_eq!(backoff_delay(5, 1000, 10_000), 10_000);
    }

    #[test]
    fn pool_collects_failures() {
        let items: Vec<u32> = (0..20).collect();
        let failures = run_pool(&items, 4, &|| false, &|item: &u32| if item % 5 == 0 { Err(*item) } else { Ok(()) });
        let mut failed: Vec<u32> = failures.into_iter().map(|(_, e)| e).collect();
        failed.sort();
        assert_eq!(failed, vec![0, 5, 10, 15]);
    }
}
