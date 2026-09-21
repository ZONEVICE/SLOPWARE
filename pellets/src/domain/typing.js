/**
 * Typing indicator service.
 *
 * A client announces `typing: true` while composing and `typing: false` when it
 * stops or sends. Because a browser tab can close mid-sentence, every flag also
 * carries a timer: if no refresh arrives within `chat.typingTimeoutMs`, the
 * flag expires on its own and the indicator disappears.
 *
 * State is per room and per SESSION (not per socket), so typing in one tab does
 * not show the same user twice.
 */
import { EVENTS } from '../lib/events.js';

/**
 * @param {{ store: object, bus: object, config: object, sessions: object, logger?: object }} deps
 */
export function createTypingService({ store, bus, config, sessions }) {
  /** @type {Map<string, Map<string, NodeJS.Timeout>>} roomId -> sessionId -> expiry timer */
  const typing = new Map();

  /** Session ids currently typing in a room. */
  function sessionIds(roomId) {
    const map = typing.get(roomId);
    return map ? [...map.keys()] : [];
  }

  /** Public views of the users currently typing in a room. */
  function list(roomId) {
    return sessionIds(roomId)
      .map((sessionId) => sessions.toPublicView(store.sessions.get(sessionId)))
      .filter(Boolean);
  }

  function publish(roomId) {
    bus.emit(EVENTS.TYPING_CHANGED, { roomId, users: list(roomId) });
  }

  /** Remove a session's flag; returns true when something actually changed. */
  function clear(roomId, sessionId, { silent = false } = {}) {
    const map = typing.get(roomId);
    if (!map) return false;
    const timer = map.get(sessionId);
    if (!timer) return false;
    clearTimeout(timer);
    map.delete(sessionId);
    if (map.size === 0) typing.delete(roomId);
    if (!silent) publish(roomId);
    return true;
  }

  /**
   * Set or refresh the typing flag for a session in a room.
   * @param {{ roomId: string, sessionId: string, typing: boolean }} input
   */
  function set({ roomId, sessionId, typing: isTyping }) {
    if (!isTyping) return clear(roomId, sessionId);

    let map = typing.get(roomId);
    if (!map) {
      map = new Map();
      typing.set(roomId, map);
    }

    const existing = map.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      clear(roomId, sessionId);
    }, config.chat.typingTimeoutMs);
    // Never keep the event loop alive just for a typing indicator.
    if (typeof timer.unref === 'function') timer.unref();
    map.set(sessionId, timer);

    // Only announce when the flag is new; refreshes are silent.
    if (!existing) publish(roomId);
    return true;
  }

  /** Drop every flag a session holds, e.g. when its last socket closes. */
  function clearSessionEverywhere(sessionId) {
    for (const roomId of [...typing.keys()]) clear(roomId, sessionId);
  }

  /** Drop every flag in a room, e.g. when the room is deleted. */
  function clearRoom(roomId) {
    const map = typing.get(roomId);
    if (!map) return;
    for (const timer of map.values()) clearTimeout(timer);
    typing.delete(roomId);
  }

  /** Release every timer. Called on graceful shutdown and by tests. */
  function stop() {
    for (const map of typing.values()) {
      for (const timer of map.values()) clearTimeout(timer);
    }
    typing.clear();
  }

  return { set, clear, clearSessionEverywhere, clearRoom, list, sessionIds, stop };
}
