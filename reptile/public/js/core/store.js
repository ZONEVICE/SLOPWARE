/**
 * The client's single source of truth: the latest server snapshot.
 *
 * The server always sends complete snapshots (see src/http/sse.js), so the
 * store never merges anything: `set` replaces, subscribers re-render what they
 * own. Only `public/js/core/live.js` calls `set`.
 */
export function createStore() {
  let state = null;
  let online = false;
  const listeners = new Set();
  const linkListeners = new Set();

  return {
    /** The latest snapshot, or null before the first one arrives. */
    get() {
      return state;
    },

    set(next) {
      state = next;
      for (const listener of [...listeners]) listener(state);
    },

    /**
     * Call `listener` now (if a snapshot exists) and on every change.
     * @returns {() => void} Unsubscribe.
     */
    subscribe(listener) {
      listeners.add(listener);
      if (state) listener(state);
      return () => listeners.delete(listener);
    },

    /** Whether the event stream to the server is currently open. */
    get online() {
      return online;
    },

    setOnline(value) {
      if (online === value) return;
      online = value;
      for (const listener of [...linkListeners]) listener(online);
    },

    onLink(listener) {
      linkListeners.add(listener);
      listener(online);
      return () => linkListeners.delete(listener);
    },
  };
}
