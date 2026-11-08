/**
 * The front end's publish/subscribe seam. Components announce what happened
 * (`doc:dirty`, `tab:active`, `fs:changed`, `settings:changed`, ...) and
 * whoever cares listens; nothing calls another component's internals for
 * notifications. The events in use are listed in CLAUDE.md.
 */
export function createBus() {
  const handlers = new Map();
  return {
    /** Subscribes; returns the unsubscribe function. */
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => handlers.get(event)?.delete(fn);
    },
    /** Publishes; a failing handler never stops the others. */
    emit(event, ...args) {
      for (const fn of [...(handlers.get(event) || [])]) {
        try {
          fn(...args);
        } catch (err) {
          console.error(`[bus] handler for ${event} failed`, err);
        }
      }
    },
  };
}
