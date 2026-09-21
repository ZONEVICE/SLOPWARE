/**
 * Client application state.
 *
 * A tiny observable store: data lives in `state`, changes are announced on
 * named channels, and views subscribe only to the channels they care about.
 * No framework, no virtual DOM, no re-render of the world on every frame.
 *
 * Channels: 'session', 'rooms', 'connection', 'users', 'limits'.
 */

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();

export const state = {
  /** Private session view from the server, or null before the first frame. */
  session: null,
  /** roomId -> room view. Kept as a Map so updates are O(1). */
  rooms: new Map(),
  /** 'connecting' | 'online' | 'offline' */
  connection: 'connecting',
  /**
   * LIVE USER DIRECTORY: sessionId -> { id, displayName, colorHue }.
   *
   * Messages carry an immutable author snapshot, but this directory is what the
   * UI actually renders. When someone renames themselves, `user:updated` patches
   * this map and every message they ever sent repaints, without the server ever
   * rewriting stored history.
   */
  users: new Map(),
  /** Server-declared limits (message length, upload size, ...). */
  limits: {},
};

/**
 * Subscribe to a channel.
 * @param {string} channel
 * @param {(payload: any) => void} handler
 * @returns {() => void} Unsubscribe.
 */
export function subscribe(channel, handler) {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  set.add(handler);
  return () => {
    const current = listeners.get(channel);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) listeners.delete(channel);
  };
}

/** Notify a channel. A throwing listener never blocks the others. */
export function publish(channel, payload) {
  const set = listeners.get(channel);
  if (!set) return;
  for (const handler of Array.from(set)) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`[state] listener for "${channel}" failed`, error);
    }
  }
}

// --- Session ---------------------------------------------------------------

export function setSession(session) {
  state.session = session;
  if (session) rememberUser({ id: session.id, displayName: session.displayName, colorHue: session.colorHue });
  publish('session', session);
}

export function setLimits(limits) {
  state.limits = limits || {};
  publish('limits', state.limits);
}

/** True once the client has picked a username, the only required step. */
export function isIdentified() {
  return Boolean(state.session && state.session.displayName);
}

/** Own session id, or null. */
export function selfId() {
  return state.session ? state.session.id : null;
}

// --- Connection -------------------------------------------------------------

export function setConnection(status) {
  if (state.connection === status) return;
  state.connection = status;
  publish('connection', status);
}

// --- Rooms ------------------------------------------------------------------

export function setRooms(list) {
  state.rooms = new Map((list || []).map((room) => [room.id, room]));
  publish('rooms', roomList());
}

export function upsertRoom(room) {
  if (!room || !room.id) return;
  state.rooms.set(room.id, room);
  if (room.createdBy) rememberUser({ id: room.createdBy.id, displayName: room.createdBy.displayName });
  publish('rooms', roomList());
}

export function removeRoom(roomId) {
  if (!state.rooms.delete(roomId)) return;
  publish('rooms', roomList());
}

export function getRoom(roomId) {
  return state.rooms.get(roomId) || null;
}

/** Rooms sorted by most recent activity, which is how Home lists them. */
export function roomList() {
  return [...state.rooms.values()].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
}

// --- User directory ---------------------------------------------------------

/**
 * Record or refresh what we know about a user.
 * Partial updates are merged, so a room card that only knows a creator's name
 * never wipes a colour learned from a message.
 */
export function rememberUser(user) {
  if (!user || !user.id) return;
  const previous = state.users.get(user.id) || {};
  const next = { ...previous, ...user };
  const changed =
    previous.displayName !== next.displayName || previous.colorHue !== next.colorHue;
  state.users.set(user.id, next);
  if (changed) publish('users', next);
}

/**
 * Best known identity for a user id, falling back to a snapshot.
 * @param {string} id
 * @param {{ displayName?: string, colorHue?: number }} [fallback] Usually the
 *   author snapshot stored inside a message.
 */
export function userOf(id, fallback = null) {
  const known = state.users.get(id);
  if (known && known.displayName) return known;
  return fallback || known || { id, displayName: 'Unknown', colorHue: null };
}

/** Reset everything. Used when the socket resolves a different session. */
export function resetState() {
  state.rooms.clear();
  state.users.clear();
  publish('rooms', []);
}
