/**
 * Domain composition root.
 *
 * Creates every service and wires their dependencies. Services are plain
 * factories with explicit dependencies, which is what makes the whole domain
 * trivially testable without an HTTP server (see `tests/domain.test.js`).
 *
 * TO ADD A FEATURE: write `src/domain/<feature>.js` exporting a factory, then
 * create it here and pass it to the transports. Nothing else needs to change.
 */
import { createSessionService } from './sessions.js';
import { createRoomService } from './rooms.js';
import { createMessageService } from './messages.js';
import { createPresenceService } from './presence.js';
import { createTypingService } from './typing.js';
import { createUploadService } from './uploads.js';

/**
 * @param {{ store: object, bus: object, config: object, logger?: object }} deps
 * @returns {{ sessions: object, rooms: object, messages: object, presence: object, typing: object, uploads: object, stop: () => void }}
 */
export function createDomain({ store, bus, config, logger }) {
  const scoped = (name) => logger?.child?.(name) || logger;

  const sessions = createSessionService({ store, bus, config, logger: scoped('sessions') });
  const rooms = createRoomService({ store, bus, config, sessions, logger: scoped('rooms') });
  const uploads = createUploadService({ store, bus, config, logger: scoped('uploads') });
  const messages = createMessageService({
    store,
    bus,
    config,
    sessions,
    rooms,
    uploads,
    logger: scoped('messages'),
  });
  const presence = createPresenceService({ store, bus, sessions, rooms, logger: scoped('presence') });
  const typing = createTypingService({ store, bus, config, sessions });

  return {
    sessions,
    rooms,
    messages,
    presence,
    typing,
    uploads,
    /** Release timers held by services. */
    stop() {
      typing.stop();
    },
  };
}
