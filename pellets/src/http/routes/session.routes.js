/**
 * Session endpoints.
 *
 * The session itself is created by the middleware on EVERY request, including
 * the one that serves `index.html`. These routes only read it back and let the
 * Settings screen change the parts that are allowed to change.
 *
 * The UUID is never writable: it is assigned once and returned as-is forever.
 */
import { json } from '../respond.js';
import { readJson } from '../body.js';

/**
 * @param {object} router
 * @param {{ domain: object, config: object }} deps
 */
export default function sessionRoutes(router, { domain, config }) {
  /** Current session, as the owning client sees it. */
  router.get('/api/session', async (ctx) => {
    json(ctx.res, 200, {
      session: domain.sessions.toPrivateView(ctx.session),
      // Everything the client needs to configure itself, in one round trip.
      realtime: { path: config.realtime.path },
      limits: {
        maxMessageLength: config.chat.maxMessageLength,
        maxDisplayNameLength: config.chat.maxDisplayNameLength,
        maxRoomNameLength: config.chat.maxRoomNameLength,
        maxRoomTopicLength: config.chat.maxRoomTopicLength,
        maxAttachmentsPerMessage: config.chat.maxAttachmentsPerMessage,
        maxUploadBytes: config.uploads.maxBytes,
      },
    });
  });

  /**
   * Update the profile.
   * Body: { displayName?, colorHue?, theme? }
   *
   * Choosing `displayName` for the first time also assigns the random colour,
   * which is why the whole "join the chat" flow is a single request.
   */
  router.patch('/api/session', async (ctx) => {
    const body = await readJson(ctx.req);
    const { session } = domain.sessions.updateProfile(ctx.session.id, body);
    json(ctx.res, 200, { session: domain.sessions.toPrivateView(session) });
  });

  // Browsers that cannot send PATCH (or a plain <form>) may POST instead.
  router.post('/api/session', async (ctx) => {
    const body = await readJson(ctx.req);
    const { session } = domain.sessions.updateProfile(ctx.session.id, body);
    json(ctx.res, 200, { session: domain.sessions.toPrivateView(session) });
  });
}
