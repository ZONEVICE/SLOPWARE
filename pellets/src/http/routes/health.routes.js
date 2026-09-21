/**
 * Operational endpoints.
 *
 * `/api/health` is deliberately boring: it reports that the process is up and
 * how much state it is holding. Everything it counts lives in memory and resets
 * to zero when the process restarts, which makes it a quick way to confirm the
 * "no persistence" guarantee.
 */
import { json } from '../respond.js';

/**
 * @param {object} router
 * @param {{ domain: object, config: object, store: object, startedAt: number }} deps
 */
export default function healthRoutes(router, { config, store, startedAt }) {
  router.get('/api/health', async (ctx) => {
    json(ctx.res, 200, {
      status: 'ok',
      protocol: config.protocol,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      startedAt,
      counts: {
        sessions: store.sessions.size,
        rooms: store.rooms.size,
        messages: store.messages.total(),
        uploads: store.uploads.size,
        connections: store.presence.connectionCount,
        onlineSessions: store.presence.onlineSessionCount,
      },
    });
  });
}
