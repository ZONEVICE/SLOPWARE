/**
 * Room endpoints.
 *
 * These mirror the WebSocket commands exactly: both transports call the same
 * domain service, so a room created over REST is broadcast to every open
 * WebSocket through the event bus, and vice versa. The REST surface exists so
 * the application is scriptable and testable without a socket.
 */
import { json, noContent } from '../respond.js';
import { readJson } from '../body.js';

/**
 * @param {object} router
 * @param {{ domain: object }} deps
 */
export default function roomRoutes(router, { domain }) {
  /** Every open room, newest first, with live user and message counts. */
  router.get('/api/rooms', async (ctx) => {
    json(ctx.res, 200, { rooms: domain.rooms.list() });
  });

  /** Create a room. Body: { name, topic? } */
  router.post('/api/rooms', async (ctx) => {
    const body = await readJson(ctx.req);
    const room = domain.rooms.create({ name: body.name, topic: body.topic, session: ctx.session });
    json(ctx.res, 201, { room: domain.rooms.toView(room) });
  });

  /** A single room. 404 once it has been deleted. */
  router.get('/api/rooms/:id', async (ctx) => {
    const room = domain.rooms.requireRoom(ctx.params.id);
    json(ctx.res, 200, { room: domain.rooms.toView(room) });
  });

  /** Delete a room. Rejected with 403 for anyone but its creator. */
  router.delete('/api/rooms/:id', async (ctx) => {
    domain.rooms.remove(ctx.params.id, ctx.session);
    noContent(ctx.res);
  });

  /**
   * Full message history of a room, oldest first.
   * `?limit=N` returns only the newest N entries.
   */
  router.get('/api/rooms/:id/messages', async (ctx) => {
    const limit = Number.parseInt(ctx.url.searchParams.get('limit') || '', 10);
    const messages = domain.messages.history(ctx.params.id, {
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    });
    json(ctx.res, 200, { roomId: ctx.params.id, messages });
  });

  /**
   * Post a message over REST. The WebSocket path is what the UI uses; this
   * exists for scripting and for the test suite.
   * Body: { body?, attachmentIds? }
   */
  router.post('/api/rooms/:id/messages', async (ctx) => {
    const body = await readJson(ctx.req);
    const message = domain.messages.create({
      roomId: ctx.params.id,
      session: ctx.session,
      body: body.body,
      attachmentIds: body.attachmentIds,
    });
    json(ctx.res, 201, { message });
  });
}
