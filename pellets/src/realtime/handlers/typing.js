/**
 * Typing indicator frames.
 *
 * The client sends `typing:set { roomId, typing: true }` while composing and
 * refreshes it periodically; the service expires the flag on its own if the
 * refreshes stop, so a closed tab never leaves a ghost indicator behind.
 */
import { C2S } from '../protocol.js';

export default function typingHandlers(registry, { domain }) {
  registry.register(C2S.TYPING_SET, (ctx) => {
    const roomId = ctx.payload.roomId;
    if (!domain.presence.isSessionInRoom(roomId, ctx.connection.sessionId)) return;
    domain.typing.set({
      roomId,
      sessionId: ctx.connection.sessionId,
      typing: Boolean(ctx.payload.typing),
    });
    // Returns nothing on purpose: typing is fire-and-forget, and the client
    // sends it with `send()` rather than `request()`.
  });
}
