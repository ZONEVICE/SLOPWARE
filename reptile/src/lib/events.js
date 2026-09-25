/**
 * Minimal synchronous event bus.
 *
 * ARCHITECTURE NOTE (read this before adding features):
 * The bus is the seam between the rules and the outside world. The discovery,
 * hosting and syncing services never talk to a browser: they publish an event
 * here and whoever cares subscribes. The server-sent-events hub that keeps the
 * interface live is one subscriber; the console reporter is another. A new
 * feature (desktop notifications, an audit log...) can listen to existing
 * events without a single existing file importing it.
 *
 * Events are delivered synchronously, in subscription order. A throwing
 * subscriber is reported through `onError` and never prevents the remaining
 * subscribers from running.
 */
export class EventBus {
  /**
   * @param {{ onError?: (error: Error, event: string) => void }} [options]
   */
  constructor(options = {}) {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    this.onError =
      options.onError ||
      ((error, event) => {
        // Never swallow silently, but never crash the process either.
        console.error(`[events] listener for "${event}" threw:`, error);
      });
  }

  /**
   * Subscribe to an event.
   * @param {string} event One of the `EVENTS` values.
   * @param {Function} handler Receives the published payload.
   * @returns {() => void} Unsubscribe function.
   */
  on(event, handler) {
    if (typeof handler !== 'function') throw new TypeError('EventBus.on expects a function handler');
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  /**
   * Remove a previously registered handler.
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.listeners.delete(event);
  }

  /**
   * Publish an event to every subscriber.
   * @param {string} event
   * @param {any} [payload]
   */
  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    // Copy first: a handler is allowed to unsubscribe itself during delivery.
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (error) {
        this.onError(error, event);
      }
    }
  }

  /** Drop every subscription. Used by graceful shutdown and by tests. */
  clear() {
    this.listeners.clear();
  }
}

/**
 * Canonical event names.
 *
 * Keep every published event listed here. A typo in a string literal is silent;
 * a typo in an imported constant is an immediate crash.
 */
export const EVENTS = Object.freeze({
  /** Something the interface displays changed. Payload: `{ section }`. */
  STATE_CHANGED: 'state.changed',

  /** The single-mode controller switched modes. Payload: `{ from, to }`. */
  MODE_CHANGED: 'mode.changed',

  /** A new entry was appended to an activity log. Payload: the entry. */
  ACTIVITY: 'activity.added',

  /** Hosting lifecycle. Payloads carry the public hosting summary. */
  HOSTING_STARTED: 'hosting.started',
  HOSTING_STOPPED: 'hosting.stopped',
  HOSTING_PIN_CHANGED: 'hosting.pinChanged',
  HOSTING_PEER_CONNECTED: 'hosting.peerConnected',
  HOSTING_PEER_DISCONNECTED: 'hosting.peerDisconnected',

  /** The syncing engine moved to another connection state. Payload: `{ state, previous }`. */
  SYNC_STATE: 'sync.state',

  /** Discovery found, updated or lost instances. Payload: `{ instances }`. */
  DISCOVERY_UPDATED: 'discovery.updated',
});
