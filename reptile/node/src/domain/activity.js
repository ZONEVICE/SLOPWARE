/**
 * A bounded, in-memory log of what the current session did: files sent and
 * received, connections, warnings. The interface shows the most recent entries
 * so that both sides can see synchronisation happening.
 *
 * Nothing is written to disk, like every other piece of state in Reptile.
 */
import { EVENTS } from '../lib/events.js';

/**
 * @typedef {object} ActivityEntry
 * @property {number} id
 * @property {number} at Epoch milliseconds.
 * @property {'sent'|'received'|'info'|'warning'|'error'} kind
 * @property {string} [op] mkdir | write | unlink | rmdir | rename
 * @property {string} [path]
 * @property {string} [to] Destination of a rename.
 * @property {number} [size]
 * @property {string} [message]
 */

/**
 * @param {{ bus?: import('../lib/events.js').EventBus, limit?: number, source?: string }} [options]
 */
export function createActivityLog({ bus, limit = 200, source = 'activity' } = {}) {
  /** @type {ActivityEntry[]} */
  let entries = [];
  let nextId = 1;

  return {
    /**
     * Append an entry.
     * @param {Omit<ActivityEntry, 'id'|'at'>} entry
     */
    add(entry) {
      const record = { id: nextId, at: Date.now(), ...entry };
      nextId += 1;
      entries.push(record);
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
      bus?.emit(EVENTS.ACTIVITY, { source, entry: record });
      bus?.emit(EVENTS.STATE_CHANGED, { section: source });
      return record;
    },

    /** Most recent first. */
    recent(count = 50) {
      return entries.slice(-count).reverse();
    },

    clear() {
      entries = [];
      bus?.emit(EVENTS.STATE_CHANGED, { section: source });
    },
  };
}
