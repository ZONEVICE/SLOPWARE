/**
 * WebSocket wire protocol.
 *
 * Every frame is JSON with the same envelope:
 *
 *   client -> server   { "type": "...", "id": "c17", "payload": { ... } }
 *   server -> client   { "type": "...", "replyTo": "c17", "payload": { ... } }
 *
 * `id` is optional and opaque to the server; it is echoed back as `replyTo` so
 * a client can correlate an answer (or an error) with the request that caused
 * it. Server-initiated frames simply have no `replyTo`.
 *
 * Keep every type listed here. Handlers and broadcasters import these constants
 * so a typo fails loudly at import time instead of silently doing nothing.
 */

/** Frames the client sends. */
export const C2S = Object.freeze({
  PING: 'ping',
  ROOMS_LIST: 'rooms:list',
  ROOM_CREATE: 'room:create',
  ROOM_DELETE: 'room:delete',
  ROOM_JOIN: 'room:join',
  ROOM_LEAVE: 'room:leave',
  MESSAGE_SEND: 'message:send',
  TYPING_SET: 'typing:set',
  PROFILE_UPDATE: 'profile:update',
});

/** Frames the server sends. */
export const S2C = Object.freeze({
  PONG: 'pong',
  /**
   * Generic acknowledgement. The gateway sends it automatically when a handler
   * returns a value and the client supplied an `id`, so every request-shaped
   * frame always gets exactly one answer: an `ack` or an `error`.
   */
  ACK: 'ack',
  /** Sent immediately after the socket opens, and after any profile change. */
  SESSION_STATE: 'session:state',
  /** Full room list; the Home screen renders straight from this. */
  ROOMS_STATE: 'rooms:state',
  ROOM_CREATED: 'room:created',
  ROOM_DELETED: 'room:deleted',
  /** Live counters for one room (user count, message count, last activity). */
  ROOM_STATS: 'room:stats',
  /** Answer to room:join: history plus the current member list. */
  ROOM_JOINED: 'room:joined',
  ROOM_LEFT: 'room:left',
  MESSAGE_NEW: 'message:new',
  TYPING_STATE: 'typing:state',
  PRESENCE_STATE: 'presence:state',
  /** A user changed their name or colour; clients patch rendered messages. */
  USER_UPDATED: 'user:updated',
  ERROR: 'error',
});

/**
 * Build a server frame.
 * @param {string} type
 * @param {any} [payload]
 * @param {string} [replyTo]
 */
export function frame(type, payload = {}, replyTo = undefined) {
  return replyTo ? { type, replyTo, payload } : { type, payload };
}

/**
 * Parse an incoming frame defensively.
 * @param {string|Buffer} raw
 * @returns {{ ok: true, type: string, id: string|undefined, payload: object } | { ok: false, reason: string }}
 */
export function parseFrame(raw) {
  let text;
  try {
    text = typeof raw === 'string' ? raw : raw.toString('utf8');
  } catch {
    return { ok: false, reason: 'Frame is not valid UTF-8 text.' };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'Frame is not valid JSON.' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'Frame must be a JSON object.' };
  }
  if (typeof parsed.type !== 'string' || !parsed.type) {
    return { ok: false, reason: 'Frame is missing a "type".' };
  }

  const payload =
    parsed.payload && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload) ? parsed.payload : {};
  const id = typeof parsed.id === 'string' ? parsed.id.slice(0, 64) : undefined;

  return { ok: true, type: parsed.type, id, payload };
}
