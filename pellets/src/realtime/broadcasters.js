/**
 * Bus -> WebSocket fan-out.
 *
 * THE DECOUPLING SEAM: domain services publish events and know nothing about
 * sockets; this module is the only place that turns an event into a frame.
 * A new feature can therefore emit its own events, and a new broadcaster can
 * relay existing events, without either touching the other.
 */
import { EVENTS } from '../lib/events.js';
import { S2C } from './protocol.js';

/**
 * @param {{ bus: object, gateway: object, domain: object, logger?: object }} deps
 * @returns {() => void} Unsubscribe everything.
 */
export function attachBroadcasters({ bus, gateway, domain, logger }) {
  /** @type {(() => void)[]} */
  const offs = [];
  const on = (event, handler) => offs.push(bus.on(event, handler));

  // --- Rooms ---------------------------------------------------------------

  // Everyone sees a new room appear in the Home list immediately.
  on(EVENTS.ROOM_CREATED, ({ view }) => {
    gateway.broadcast(S2C.ROOM_CREATED, { room: view });
  });

  on(EVENTS.ROOM_DELETED, ({ roomId, room }) => {
    // Typing timers for a room that no longer exists would fire into the void.
    domain.typing.clearRoom(roomId);
    // Broadcast to everyone: clients viewing the room bounce back to Home,
    // clients on Home just drop the entry from the list.
    gateway.broadcast(S2C.ROOM_DELETED, { roomId, name: room?.name || null });
    logger?.debug?.('broadcast room deleted', roomId);
  });

  // Live user/message counters for the Home list.
  on(EVENTS.ROOM_STATS, ({ view }) => {
    gateway.broadcast(S2C.ROOM_STATS, { room: view });
  });

  // --- Messages ------------------------------------------------------------

  on(EVENTS.MESSAGE_CREATED, ({ roomId, message }) => {
    // The sender is included on purpose: every client, including the author,
    // renders from the canonical stored record rather than a local guess.
    gateway.toRoom(roomId, S2C.MESSAGE_NEW, { roomId, message });
    // A new message changes the room's last-activity preview on Home.
    domain.rooms.publishStats(roomId);
  });

  // --- Presence and typing -------------------------------------------------

  on(EVENTS.PRESENCE_CHANGED, ({ roomId, members, userCount }) => {
    gateway.toRoom(roomId, S2C.PRESENCE_STATE, { roomId, members, userCount });
  });

  on(EVENTS.TYPING_CHANGED, ({ roomId, users }) => {
    gateway.toRoom(roomId, S2C.TYPING_STATE, { roomId, users });
  });

  // --- Sessions ------------------------------------------------------------

  on(EVENTS.SESSION_UPDATED, ({ session, changed }) => {
    // Every tab of this user stays in sync (name, colour and theme).
    gateway.toSession(session.id, S2C.SESSION_STATE, {
      session: domain.sessions.toPrivateView(session),
    });

    // A name or colour change is visible to other people, so they can repaint
    // the messages this user already sent.
    if (changed.includes('displayName') || changed.includes('colorHue')) {
      gateway.broadcast(S2C.USER_UPDATED, { user: domain.sessions.toPublicView(session) });
      // Refresh the member list of every room the user is currently in.
      for (const roomId of domain.presence.roomsOfSession(session.id)) domain.presence.publish(roomId);
    }
  });

  return () => {
    for (const off of offs) off();
    offs.length = 0;
  };
}
