/**
 * Presence service: which sockets are attached to which rooms.
 *
 * Wraps the presence store with room validation and event publishing. The
 * WebSocket gateway calls this; nothing here knows what a WebSocket is.
 */
import { EVENTS } from '../lib/events.js';

/**
 * @param {{ store: object, bus: object, sessions: object, rooms: object, logger?: object }} deps
 */
export function createPresenceService({ store, bus, sessions, rooms, logger }) {
  /** Public member list of a room: identity + colour for the sidebar. */
  function members(roomId) {
    return store.presence
      .sessionsInRoom(roomId)
      .map((sessionId) => sessions.toPublicView(store.sessions.get(sessionId)))
      .filter(Boolean);
  }

  /** Emit both the room-level stats (Home) and the member list (room view). */
  function publish(roomId) {
    if (!store.rooms.has(roomId)) return;
    rooms.publishStats(roomId);
    bus.emit(EVENTS.PRESENCE_CHANGED, {
      roomId,
      members: members(roomId),
      userCount: store.presence.countInRoom(roomId),
    });
  }

  return {
    members,
    publish,

    /** Register a new socket. */
    connect(connectionId, sessionId) {
      store.presence.addConnection(connectionId, sessionId);
      logger?.debug?.('connection', connectionId, 'session', sessionId);
    },

    /**
     * Attach a socket to a room. Throws when the room does not exist.
     * @returns {{ sessionJoined: boolean }}
     */
    join(roomId, connectionId) {
      rooms.requireRoom(roomId);
      const result = store.presence.join(roomId, connectionId);
      if (result.sessionJoined) publish(roomId);
      return result;
    },

    /** Detach a socket from a room. Silent when it was not in it. */
    leave(roomId, connectionId) {
      const result = store.presence.leave(roomId, connectionId);
      if (result.sessionLeft) publish(roomId);
      return result;
    },

    /**
     * Remove a socket completely and refresh every room it was in.
     * @returns {{ sessionId: string|null, rooms: string[], sessionLeftRooms: string[] }}
     */
    disconnect(connectionId) {
      const result = store.presence.removeConnection(connectionId);
      for (const roomId of result.sessionLeftRooms) publish(roomId);
      return result;
    },

    countInRoom: (roomId) => store.presence.countInRoom(roomId),
    connectionsInRoom: (roomId) => store.presence.connectionsInRoom(roomId),
    connectionsOfSession: (sessionId) => store.presence.connectionsOfSession(sessionId),
    roomsOfConnection: (connectionId) => store.presence.roomsOfConnection(connectionId),
    roomsOfSession: (sessionId) => store.presence.roomsOfSession(sessionId),
    isSessionInRoom: (roomId, sessionId) => store.presence.isSessionInRoom(roomId, sessionId),
  };
}
