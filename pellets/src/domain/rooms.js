/**
 * Room service.
 *
 * Rules from the specification:
 *  - Anyone with a username can create a room; there is no limit on how many.
 *  - An empty room stays open and stays listed.
 *  - ONLY the session that created a room may delete it.
 */
import { uuid4, isUuid4 } from '../lib/ids.js';
import { EVENTS } from '../lib/events.js';
import { errors } from './errors.js';

/**
 * @param {{ store: object, bus: object, config: object, sessions: object, logger?: object }} deps
 */
export function createRoomService({ store, bus, config, sessions, logger }) {
  const limits = config.chat;

  /** Normalise a room name: any characters, just bounded and non-empty. */
  function normalizeName(value) {
    if (typeof value !== 'string') throw errors.badRequest('Room name must be text.');
    const trimmed = value.trim().replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ');
    if (!trimmed) throw errors.badRequest('Room name cannot be empty.');
    if ([...trimmed].length > limits.maxRoomNameLength) {
      throw errors.badRequest(`Room name cannot exceed ${limits.maxRoomNameLength} characters.`);
    }
    return trimmed;
  }

  /** Optional one-line description shown under the room name. */
  function normalizeTopic(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') throw errors.badRequest('Room topic must be text.');
    const trimmed = value.trim().replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ');
    if ([...trimmed].length > limits.maxRoomTopicLength) {
      throw errors.badRequest(`Room topic cannot exceed ${limits.maxRoomTopicLength} characters.`);
    }
    return trimmed;
  }

  /**
   * Public projection of a room, including the live counters the Home list
   * renders. Deliberately does NOT include a "canDelete" flag: the client
   * compares `createdBy.id` against its own session id.
   */
  function toView(room) {
    const last = store.messages.last(room.id);
    return {
      id: room.id,
      name: room.name,
      topic: room.topic,
      createdAt: room.createdAt,
      createdBy: { id: room.createdBy, displayName: room.createdByName },
      userCount: store.presence.countInRoom(room.id),
      messageCount: store.messages.count(room.id),
      lastActivityAt: last ? last.createdAt : room.createdAt,
      lastMessage: last
        ? {
            authorName: last.author?.displayName || null,
            // Short preview only; the full body lives in the room history.
            preview: last.body ? last.body.slice(0, 140) : attachmentPreview(last),
            createdAt: last.createdAt,
          }
        : null,
    };
  }

  /** Text stand-in for a message that carries only attachments. */
  function attachmentPreview(message) {
    const count = message.attachments?.length || 0;
    if (count === 0) return '';
    const kind = message.attachments[0].kind;
    if (count === 1) return kind === 'image' ? 'Photo' : kind === 'video' ? 'Video' : 'File';
    return `${count} attachments`;
  }

  /**
   * Create a room.
   * @param {{ name: string, topic?: string, session: object }} input
   */
  function create({ name, topic, session }) {
    sessions.requireIdentified(session);
    const room = {
      id: uuid4(),
      name: normalizeName(name),
      topic: normalizeTopic(topic),
      createdBy: session.id,
      createdByName: session.displayName,
      createdAt: Date.now(),
    };
    store.rooms.insert(room);
    logger?.debug?.('room created', room.id, room.name);
    bus.emit(EVENTS.ROOM_CREATED, { room, view: toView(room) });
    return room;
  }

  /**
   * Delete a room. Only its creator may do so.
   * @param {string} roomId
   * @param {object} session
   * @returns {{ room: object, connections: string[] }} `connections` are the
   *   sockets that were inside and must be sent back to Home.
   */
  function remove(roomId, session) {
    sessions.requireIdentified(session);
    const room = requireRoom(roomId);
    if (room.createdBy !== session.id) {
      throw errors.forbidden('Only the user who created this room can delete it.');
    }

    const connections = store.presence.dropRoom(roomId);
    store.messages.dropRoom(roomId);
    store.rooms.delete(roomId);
    logger?.debug?.('room deleted', roomId);
    bus.emit(EVENTS.ROOM_DELETED, { roomId, room, connections });
    return { room, connections };
  }

  /** @returns {object|undefined} */
  function get(roomId) {
    if (!isUuid4(roomId)) return undefined;
    return store.rooms.get(roomId);
  }

  /** Same as `get`, but throws the canonical 404 instead of returning undefined. */
  function requireRoom(roomId) {
    const room = get(roomId);
    if (!room) throw errors.roomNotFound();
    return room;
  }

  /** Every room, newest first, as views. */
  function list() {
    return store.rooms.all().map(toView);
  }

  /** Emit a stats update so open Home screens refresh their user counts. */
  function publishStats(roomId) {
    const room = store.rooms.get(roomId);
    if (!room) return;
    bus.emit(EVENTS.ROOM_STATS, { roomId, view: toView(room) });
  }

  return { create, remove, get, requireRoom, list, toView, publishStats, normalizeName, normalizeTopic };
}
