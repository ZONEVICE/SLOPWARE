/**
 * Small concurrency primitives.
 *
 * Synchronisation is where a sync tool earns or loses its correctness, so these
 * are deliberately boring: a serial queue, a mutex built on it, and a bounded
 * worker pool.
 */

/**
 * Runs async tasks one at a time, in submission order.
 *
 * The syncing engine pushes every disk-touching step through one of these
 * (remote changes, local change batches, full reconciliations), so two steps
 * can never interleave on the same file.
 *
 * IMPORTANT: a task must never `await queue.push(...)` on its own queue. It
 * would wait for itself forever. Schedule and move on instead.
 */
export class SerialQueue {
  constructor() {
    /** @type {{ fn: Function, resolve: Function, reject: Function }[]} */
    this.pending = [];
    this.running = false;
    /** @type {Function[]} */
    this.idleWaiters = [];
  }

  /** Tasks waiting to start (the running one is not counted). */
  get size() {
    return this.pending.length;
  }

  /** True while a task is running or waiting. */
  get busy() {
    return this.running || this.pending.length > 0;
  }

  /**
   * Enqueue a task.
   * @template T
   * @param {() => Promise<T>|T} fn
   * @returns {Promise<T>}
   */
  push(fn) {
    return new Promise((resolve, reject) => {
      this.pending.push({ fn, resolve, reject });
      this.#drain();
    });
  }

  /**
   * Drop every task that has not started yet. Their promises resolve with
   * `undefined` so that nobody awaiting them hangs.
   */
  clear() {
    const dropped = this.pending.splice(0);
    for (const task of dropped) task.resolve(undefined);
    if (!this.running) this.#notifyIdle();
  }

  /** Resolves once the queue is empty and nothing is running. */
  idle() {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async #drain() {
    if (this.running) return;
    this.running = true;
    while (this.pending.length > 0) {
      const task = this.pending.shift();
      try {
        task.resolve(await task.fn());
      } catch (error) {
        task.reject(error);
      }
    }
    this.running = false;
    this.#notifyIdle();
  }

  #notifyIdle() {
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}

/**
 * Mutual exclusion for async sections.
 *
 * The host serialises "commit" steps (renaming a received file into place and
 * updating its index) against the processing of its own watcher batches, so a
 * batch never observes a half-applied change.
 */
export class Mutex {
  constructor() {
    this.queue = new SerialQueue();
  }

  /**
   * Run `fn` while holding the lock.
   * @template T
   * @param {() => Promise<T>|T} fn
   * @returns {Promise<T>}
   */
  run(fn) {
    return this.queue.push(fn);
  }
}

/**
 * Process `items` with at most `limit` workers in flight.
 *
 * Errors thrown by `worker` are collected, never thrown, so one failed transfer
 * does not abandon the rest of a reconciliation.
 *
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<void>} worker
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ item: T, error: Error }[]>} The failures.
 */
export async function runPool(items, limit, worker, options = {}) {
  const failures = [];
  let next = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));

  const lane = async () => {
    while (next < items.length) {
      if (options.signal?.aborted) return;
      const index = next;
      next += 1;
      try {
        await worker(items[index], index);
      } catch (error) {
        failures.push({ item: items[index], error });
      }
    }
  };

  await Promise.all(Array.from({ length: lanes }, lane));
  return failures;
}

/**
 * Resolve after `ms`, or earlier (resolving, not rejecting) if `signal` aborts.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Exponential backoff delay: base * 2^attempt, capped.
 * @param {number} attempt Zero-based.
 * @param {{ baseMs?: number, maxMs?: number }} [options]
 */
export function backoffDelay(attempt, { baseMs = 1000, maxMs = 15000 } = {}) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
}
