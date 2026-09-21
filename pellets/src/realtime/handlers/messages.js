/**
 * Message frames.
 *
 * Sending is the only mutation: the specification forbids editing and deleting,
 * so no such frame type exists.
 */
import { C2S } from '../protocol.js';
import { errors } from '../../domain/errors.js';

export default function messageHandlers(registry, { domain }) {
  registry.register(C2S.MESSAGE_SEND, (ctx) => {
    const roomId = ctx.payload.roomId;
    // A client must actually be in the room it posts to. This is not a security
    // boundary so much as a guarantee that presence and history stay coherent.
    if (!domain.presence.isSessionInRoom(roomId, ctx.connection.sessionId)) {
      throw errors.forbidden('Join the room before sending a message.');
    }

    const message = domain.messages.create({
      roomId,
      session: ctx.session,
      body: ctx.payload.body,
      attachmentIds: ctx.payload.attachmentIds,
    });

    // Sending implies you stopped typing.
    domain.typing.clear(roomId, ctx.connection.sessionId);

    // The message itself reaches everyone in the room through the bus, sender
    // included, so the sender's own view is rendered from the canonical record.
    // Returning it here only acknowledges the request, which is what lets the
    // composer clear its text and its pending attachments.
    return { messageId: message.id, roomId };
  });
}
