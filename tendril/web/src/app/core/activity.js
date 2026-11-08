/**
 * Keeps the server's idle timeout honest.
 *
 * - **Activity pings.** Typing in the editor does not talk to the server, so
 *   while a person interacts (keys, pointer, wheel, touch) a ping is sent at
 *   most once a minute. No interaction, no ping: an abandoned tab lets the
 *   server close itself as designed.
 * - **Status polling.** Every minute (quietly - it never counts as activity)
 *   the time left before the automatic shutdown is fetched.
 * - **Countdown.** Between answers the time left is counted down here, once
 *   a second, from the last answer, and published as `idle:status` so the
 *   status bar ticks and can warn near the end. The server stops at that
 *   same moment, so when the countdown reaches zero this asks the server
 *   whether it is still there: if it answers with time left (someone used it
 *   meanwhile) the countdown resumes; if it no longer answers,
 *   `server:stopped` is published and the page says so.
 */
import { api } from './api.js';

const PING_EVERY = 60_000;
const POLL_EVERY = 60_000;
const TICK = 1_000;
/** Checks at zero: the first a moment after, then a few more. */
const CONFIRM_DELAYS = [1_500, 2_000, 3_000, 5_000, 10_000];
/** Unanswered checks in a row that mean "stopped" rather than a hiccup. */
const CONFIRM_FAILURES = 2;
/** A check that gets no answer within this time counts as unanswered. */
const CONFIRM_TIMEOUT = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function startActivity(bus) {
  let lastPing = 0;
  let interacted = false;
  let deadline = null; // performance.now() when the server stops itself
  let timeout = null; // the configured timeout, in seconds
  let confirming = false;
  let stopped = false;

  /** Records an answer from the server. */
  const update = (remaining, timeoutSecs) => {
    if (typeof remaining !== 'number') return;
    if (typeof timeoutSecs === 'number') timeout = timeoutSecs;
    deadline = performance.now() + remaining * 1000;
    bus.emit('idle:status', { remaining, timeout });
  };

  const ping = async () => {
    lastPing = Date.now();
    interacted = false;
    try {
      const result = await api.post('/api/system/ping', {});
      update(result.idle_remaining_secs);
    } catch {
      /* the status poll reports connection problems */
    }
  };

  const onInteraction = () => {
    interacted = true;
    if (Date.now() - lastPing > PING_EVERY) ping();
  };
  for (const type of ['keydown', 'pointerdown', 'wheel', 'touchstart']) {
    window.addEventListener(type, onInteraction, { capture: true, passive: true });
  }

  const status = (options = {}) => api.get('/api/system/status', { quiet: true, ...options });

  const poll = async () => {
    try {
      const answer = await status();
      update(answer.idle_remaining_secs, answer.idle_timeout_secs);
    } catch {
      /* reported by the API layer */
    }
  };

  /** The countdown reached zero: is the server still there? */
  const confirmStopped = async () => {
    confirming = true;
    let failures = 0;
    for (const delay of CONFIRM_DELAYS) {
      await sleep(delay);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), CONFIRM_TIMEOUT);
      try {
        const answer = await status({ signal: abort.signal });
        failures = 0;
        if (answer.idle_remaining_secs > 0) {
          // Someone used it meanwhile (another tab or device): carry on.
          update(answer.idle_remaining_secs, answer.idle_timeout_secs);
          confirming = false;
          return;
        }
      } catch {
        failures += 1;
        if (failures >= CONFIRM_FAILURES) {
          stopped = true;
          bus.emit('server:stopped', { reason: 'idle', timeout });
          return;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    // Still answering without time left: let the regular polling decide.
    confirming = false;
  };

  setInterval(() => {
    if (deadline === null || confirming || stopped) return;
    const remaining = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    bus.emit('idle:status', { remaining, timeout });
    if (remaining === 0) confirmStopped();
  }, TICK);

  poll();
  setInterval(() => {
    if (stopped || confirming) return;
    if (interacted && Date.now() - lastPing > PING_EVERY) ping();
    else poll();
  }, POLL_EVERY);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !stopped) poll();
  });

  return { ping, poll };
}
