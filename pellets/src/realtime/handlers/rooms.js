/**
 * Room frames: create, delete, join and leave.
 *
 * Creating and deleting delegate to the same domain service the REST routes
 * use, so authorisation ("only the creator may delete a room") lives in exactly
 * one place.
 */
import { C2S, S2C } from '../protocol.js';

export default function roomHandlers(registry, { domain }) {
  registry.register(C2S.ROOM_CREATE, (ctx) => {
    const room = domain.rooms.create({
      name: ctx.payload.name,
      topic: ctx.payload.topic,
      session: ctx.session,
    });
    // room:created reaches everyone through the bus; the reply carries the id
    // so the creating client can navigate straight into its new room.
    ctx.connection.send(S2C.ROOM_CREATED, { room: domain.rooms.toView(room) }, ctx.frameId);
  });

  registry.register(C2S.ROOM_DELETE, (ctx) => {
    domain.rooms.remove(ctx.payload.roomId, ctx.session);
    // The `room:deleted` broadcast reaches every client, this one included;
    // the returned value only acknowledges the request.
    return { roomId: ctx.payload.roomId };
  });

  /**
   * Join a room: registers presence and answers with the full history plus the
   * current member list. History is what makes earlier messages visible to a
   * client that was not in the room when they were sent.
   */
  registry.register(C2S.ROOM_JOIN, (ctx) => {
    const roomId = ctx.payload.roomId;
    const room = domain.rooms.requireRoom(roomId);
    domain.sessions.requireIdentified(ctx.session);

    domain.presence.join(roomId, ctx.connection.id);

    ctx.connection.send(
      S2C.ROOM_JOINED,
      {
        room: domain.rooms.toView(room),
        messages: domain.messages.history(roomId),
        members: domain.presence.members(roomId),
        typing: domain.typing.list(roomId),
      },
      ctx.frameId,
    );
  });

  registry.register(C2S.ROOM_LEAVE, (ctx) => {
    const roomId = ctx.payload.roomId;
    // Leaving also clears any typing flag, so the indicator cannot get stuck.
    domain.typing.clear(roomId, ctx.connection.sessionId);
    domain.presence.leave(roomId, ctx.connection.id);
    ctx.connection.send(S2C.ROOM_LEFT, { roomId }, ctx.frameId);
  });
}
