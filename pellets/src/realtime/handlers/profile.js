/**
 * Profile frames: pick a username, change colour, change theme.
 *
 * This is the frame the "choose your username" modal sends, and the only step a
 * client has to complete before it can chat. The random colour is assigned by
 * the domain service the first time a name is set.
 */
import { C2S, S2C } from '../protocol.js';

export default function profileHandlers(registry, { domain }) {
  registry.register(C2S.PROFILE_UPDATE, (ctx) => {
    const { session } = domain.sessions.updateProfile(ctx.connection.sessionId, {
      displayName: ctx.payload.displayName,
      colorHue: ctx.payload.colorHue,
      theme: ctx.payload.theme,
    });
    // The broadcaster also pushes session:state to every tab of this session
    // and user:updated to everyone else; this reply just closes the request.
    ctx.connection.send(S2C.SESSION_STATE, { session: domain.sessions.toPrivateView(session) }, ctx.frameId);
  });
}
