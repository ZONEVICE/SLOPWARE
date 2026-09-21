/**
 * Message service.
 *
 * Messages are append-only. The specification forbids editing and deleting
 * them, so no update or delete function exists here at all; that is enforced by
 * absence rather than by a permission check.
 *
 * A message carries a SNAPSHOT of its author (name + colour at send time). The
 * client additionally keeps a live user directory and re-renders names when a
 * user changes their profile, so old messages stay coherent without ever being
 * rewritten on the server.
 */
import { sortableId, isUuid4 } from '../lib/ids.js';
import { EVENTS } from '../lib/events.js';
import { errors } from './errors.js';

/**
 * @param {{ store: object, bus: object, config: object, sessions: object, rooms: object, uploads: object, logger?: object }} deps
 */
export function createMessageService({ store, bus, config, sessions, rooms, uploads, logger }) {
  const limits = config.chat;

  /** Trim and bound the text body. Empty is allowed when files are attached. */
  function normalizeBody(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw errors.badRequest('Message body must be text.');
    // Keep newlines and tabs; strip the remaining control characters.
    const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    const trimmed = cleaned.replace(/[ \t]+$/gm, '').trim();
    if ([...trimmed].length > limits.maxMessageLength) {
      throw errors.badRequest(`Message cannot exceed ${limits.maxMessageLength} characters.`);
    }
    return trimmed;
  }

  /**
   * Turn a list of upload ids into attachment snapshots, checking ownership
   * loosely (any identified session may attach an upload it received an id
   * for) and existence strictly.
   * @param {unknown} attachmentIds
   */
  function resolveAttachments(attachmentIds) {
    if (!attachmentIds) return [];
    if (!Array.isArray(attachmentIds)) throw errors.badRequest('Attachments must be a list of upload ids.');
    if (attachmentIds.length > limits.maxAttachmentsPerMessage) {
      throw errors.badRequest(`A message can carry at most ${limits.maxAttachmentsPerMessage} attachments.`);
    }

    return attachmentIds.map((id) => {
      if (!isUuid4(id)) throw errors.badRequest('Malformed attachment id.');
      const upload = uploads.get(id);
      if (!upload) throw errors.uploadNotFound();
      uploads.markAttached(id);
      return uploads.toView(upload);
    });
  }

  /**
   * Append a message to a room.
   * @param {{ roomId: string, session: object, body?: string, attachmentIds?: string[] }} input
   * @returns {object} The stored message.
   */
  function create({ roomId, session, body, attachmentIds }) {
    sessions.requireIdentified(session);
    const room = rooms.requireRoom(roomId);

    const text = normalizeBody(body);
    const attachments = resolveAttachments(attachmentIds);
    if (!text && attachments.length === 0) {
      throw errors.badRequest('A message needs text or at least one attachment.');
    }

    const message = {
      id: sortableId(),
      roomId: room.id,
      // 'user' today; the field exists so a future module can append 'system'
      // notices without changing the message schema or the client renderer.
      type: 'user',
      author: {
        id: session.id,
        displayName: session.displayName,
        colorHue: session.colorHue,
      },
      body: text,
      attachments,
      createdAt: Date.now(),
    };

    store.messages.append(room.id, message, limits.maxMessagesPerRoom);
    logger?.debug?.('message', message.id, 'in room', room.id);
    bus.emit(EVENTS.MESSAGE_CREATED, { roomId: room.id, message });
    return message;
  }

  /**
   * Full history of a room, oldest first. This is what a joining client
   * receives so it can read everything sent before it arrived.
   */
  function history(roomId, options = {}) {
    rooms.requireRoom(roomId);
    return store.messages.history(roomId, options);
  }

  return { create, history, normalizeBody };
}
