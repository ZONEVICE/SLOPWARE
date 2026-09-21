/**
 * Who is connected, and to which rooms.
 *
 * Three relationships are tracked, all in memory:
 *   connection -> session      (a browser tab belongs to one session)
 *   session    -> connections  (one user may have many tabs open)
 *   room       -> sessions -> connections
 *
 * The user count shown on the Home screen counts DISTINCT SESSIONS, not
 * sockets: opening three tabs must not look like three people.
 */
import { SetMap } from './collection.js';

export function createPresenceStore() {
  /** @type {Map<string, { sessionId: string, rooms: Set<string> }>} */
  const connections = new Map();
  /** session id -> connection ids */
  const sessionConnections = new SetMap();
  /** @type {Map<string, Map<string, Set<string>>>} roomId -> sessionId -> connectionIds */
  const rooms = new Map();

  /** Ensure the per-room map exists. */
  function roomMap(roomId) {
    let map = rooms.get(roomId);
    if (!map) {
      map = new Map();
      rooms.set(roomId, map);
    }
    return map;
  }

  return {
    /** Register a freshly opened socket. */
    addConnection(connectionId, sessionId) {
      connections.set(connectionId, { sessionId, rooms: new Set() });
      sessionConnections.add(sessionId, connectionId);
    },

    /** @returns {{ sessionId: string, rooms: Set<string> }|undefined} */
    getConnection(connectionId) {
      return connections.get(connectionId);
    },

    /**
     * Attach a connection to a room.
     * @returns {{ ok: boolean, sessionId: string|null, sessionJoined: boolean }}
     *   `sessionJoined` is true only when this is the session's FIRST
     *   connection in the room, i.e. when the visible user count changes.
     */
    join(roomId, connectionId) {
      const connection = connections.get(connectionId);
      if (!connection) return { ok: false, sessionId: null, sessionJoined: false };

      const map = roomMap(roomId);
      let set = map.get(connection.sessionId);
      const sessionJoined = !set;
      if (!set) {
        set = new Set();
        map.set(connection.sessionId, set);
      }
      set.add(connectionId);
      connection.rooms.add(roomId);
      return { ok: true, sessionId: connection.sessionId, sessionJoined };
    },

    /**
     * Detach a connection from a room.
     * @returns {{ ok: boolean, sessionId: string|null, sessionLeft: boolean }}
     *   `sessionLeft` is true when the session has no remaining connection in
     *   the room, i.e. when the visible user count changes.
     */
    leave(roomId, connectionId) {
      const connection = connections.get(connectionId);
      if (!connection) return { ok: false, sessionId: null, sessionLeft: false };

      const map = rooms.get(roomId);
      connection.rooms.delete(roomId);
      if (!map) return { ok: true, sessionId: connection.sessionId, sessionLeft: false };

      const set = map.get(connection.sessionId);
      if (!set) return { ok: true, sessionId: connection.sessionId, sessionLeft: false };

      set.delete(connectionId);
      let sessionLeft = false;
      if (set.size === 0) {
        map.delete(connection.sessionId);
        sessionLeft = true;
      }
      // An empty room keeps existing in the room store; only presence is dropped.
      if (map.size === 0) rooms.delete(roomId);
      return { ok: true, sessionId: connection.sessionId, sessionLeft };
    },

    /**
     * Remove a socket entirely (close/error).
     * @returns {{ sessionId: string|null, rooms: string[], sessionLeftRooms: string[] }}
     */
    removeConnection(connectionId) {
      const connection = connections.get(connectionId);
      if (!connection) return { sessionId: null, rooms: [], sessionLeftRooms: [] };

      const joined = [...connection.rooms];
      const sessionLeftRooms = [];
      for (const roomId of joined) {
        const result = this.leave(roomId, connectionId);
        if (result.sessionLeft) sessionLeftRooms.push(roomId);
      }

      sessionConnections.remove(connection.sessionId, connectionId);
      connections.delete(connectionId);
      return { sessionId: connection.sessionId, rooms: joined, sessionLeftRooms };
    },

    /** Distinct session ids present in a room, in join order. */
    sessionsInRoom(roomId) {
      const map = rooms.get(roomId);
      return map ? [...map.keys()] : [];
    },

    /** Number of distinct users in a room. This is what the Home list shows. */
    countInRoom(roomId) {
      const map = rooms.get(roomId);
      return map ? map.size : 0;
    },

    /** Every socket currently attached to a room, for broadcasting. */
    connectionsInRoom(roomId) {
      const map = rooms.get(roomId);
      if (!map) return [];
      const out = [];
      for (const set of map.values()) out.push(...set);
      return out;
    },

    /** Every socket belonging to a session, e.g. to sync a profile change. */
    connectionsOfSession(sessionId) {
      return [...sessionConnections.get(sessionId)];
    },

    /** Rooms a socket is currently in. */
    roomsOfConnection(connectionId) {
      const connection = connections.get(connectionId);
      return connection ? [...connection.rooms] : [];
    },

    /** Union of the rooms every socket of a session is in. */
    roomsOfSession(sessionId) {
      const out = new Set();
      for (const connectionId of sessionConnections.get(sessionId)) {
        const connection = connections.get(connectionId);
        if (!connection) continue;
        for (const roomId of connection.rooms) out.add(roomId);
      }
      return [...out];
    },

    /** True when the session has at least one socket in the room. */
    isSessionInRoom(roomId, sessionId) {
      const map = rooms.get(roomId);
      return Boolean(map && map.has(sessionId));
    },

    /**
     * Forget a room's presence entirely, used when the room is deleted.
     * @returns {string[]} The connections that were in it.
     */
    dropRoom(roomId) {
      const affected = this.connectionsInRoom(roomId);
      for (const connectionId of affected) {
        const connection = connections.get(connectionId);
        if (connection) connection.rooms.delete(roomId);
      }
      rooms.delete(roomId);
      return affected;
    },

    /** Snapshot of `{ roomId: userCount }` for every populated room. */
    countsByRoom() {
      /** @type {Record<string, number>} */
      const out = {};
      for (const [roomId, map] of rooms) out[roomId] = map.size;
      return out;
    },

    get connectionCount() {
      return connections.size;
    },

    get onlineSessionCount() {
      return sessionConnections.keys().length;
    },

    clear() {
      connections.clear();
      sessionConnections.clear();
      rooms.clear();
    },
  };
}
