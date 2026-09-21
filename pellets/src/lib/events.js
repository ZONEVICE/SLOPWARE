/**
 * Minimal synchronous event bus.
 *
 * ARCHITECTURE NOTE (read this before adding features):
 * The bus is the seam that keeps Pellets modular. Domain services never talk to
 * the WebSocket gateway directly; they publish an event here and whoever cares
 * subscribes. That is what makes a feature pluggable like a Lego brick: a new
 * feature can listen to existing events without any existing file importing it.
 *
 * Events are delivered synchronously, in subscription order. A throwing
 * subscriber is reported through `onError` and never prevents the remaining
 * subscribers from running, so one broken listener cannot take the server down.
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
        // Default: never swallow silently, but never crash the process either.
        console.error(`[events] listener for "${event}" threw:`, error);
      });
  }

  /**
   * Subscribe to an event.
   * @param {string} event Event name, conventionally "domain.action".
   * @param {Function} handler Receives the published payload.
   * @returns {() => void} Unsubscribe function.
   */
  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('EventBus.on expects a function handler');
    }
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  /**
   * Subscribe to an event for a single delivery.
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void} Unsubscribe function.
   */
  once(event, handler) {
    const wrapped = (payload) => {
      off();
      handler(payload);
    };
    const off = this.on(event, wrapped);
    return off;
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

  /** Drop every subscription. Used by tests and by graceful shutdown. */
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
export const EVENTS = {
  SESSION_CREATED: 'session.created',
  SESSION_UPDATED: 'session.updated',

  ROOM_CREATED: 'room.created',
  ROOM_DELETED: 'room.deleted',
  ROOM_STATS: 'room.stats',

  MESSAGE_CREATED: 'message.created',

  PRESENCE_CHANGED: 'presence.changed',
  TYPING_CHANGED: 'typing.changed',

  UPLOAD_STORED: 'upload.stored',
};
