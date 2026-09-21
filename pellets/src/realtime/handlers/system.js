/**
 * Connection-level frames: keepalive and the initial room list.
 */
import { C2S, S2C } from '../protocol.js';

export default function systemHandlers(registry, { domain }) {
  /** Application-level keepalive, on top of the protocol-level ping/pong. */
  registry.register(C2S.PING, (ctx) => {
    ctx.connection.send(S2C.PONG, { at: Date.now() }, ctx.frameId);
  });

  /** Explicit refresh of the Home screen list. */
  registry.register(C2S.ROOMS_LIST, (ctx) => {
    ctx.connection.send(S2C.ROOMS_STATE, { rooms: domain.rooms.list() }, ctx.frameId);
  });
}
