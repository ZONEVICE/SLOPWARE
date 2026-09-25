/**
 * Server-sent events: how the control panel stays live.
 *
 * The browser opens `GET /api/events` once. Whenever anything it displays
 * changes, the hub sends the complete state snapshot as one `state` event.
 * Complete snapshots instead of patches keep the client trivial and make a
 * reconnect self-healing: the first event after reconnecting is the truth.
 *
 * Bursts (a reconciliation reports progress for every file) are coalesced:
 * at most one snapshot per `throttleMs`, always ending with the latest state.
 */
import { EVENTS } from '../lib/events.js';
import { SECURITY_HEADERS } from './respond.js';

/**
 * @param {{ bus: import('../lib/events.js').EventBus, snapshot: () => object, throttleMs?: number, keepAliveMs?: number }} options
 */
export function createSseHub({ bus, snapshot, throttleMs = 120, keepAliveMs = 15000 }) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  let timer = null;
  let lastSent = 0;

  const write = (res, event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clients.delete(res);
    }
  };

  const broadcast = () => {
    timer = null;
    lastSent = Date.now();
    if (clients.size === 0) return;
    const state = snapshot();
    for (const res of clients) write(res, 'state', state);
  };

  const schedule = () => {
    if (timer || clients.size === 0) return;
    timer = setTimeout(broadcast, Math.max(0, throttleMs - (Date.now() - lastSent)));
  };

  const off = bus.on(EVENTS.STATE_CHANGED, schedule);
  const keepAlive = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, keepAliveMs);
  keepAlive.unref?.();

  return {
    get size() {
      return clients.size;
    },

    /** Take over a request and keep it open. */
    handle(req, res) {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      clients.add(res);
      write(res, 'state', snapshot());
      const drop = () => clients.delete(res);
      req.on('close', drop);
      res.on('error', drop);
    },

    /** Push a snapshot right away (used after a request changed something). */
    flush() {
      clearTimeout(timer);
      broadcast();
    },

    close() {
      off();
      clearTimeout(timer);
      clearInterval(keepAlive);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
