/**
 * Store composition root.
 *
 * `createStore()` wires every in-memory store together. Domain services receive
 * this object and never import the individual store modules, so adding a store
 * is a one-line change here.
 */
import { createSessionStore } from './sessions.store.js';
import { createRoomStore } from './rooms.store.js';
import { createMessageStore } from './messages.store.js';
import { createUploadStore } from './uploads.store.js';
import { createPresenceStore } from './presence.store.js';

/**
 * @returns {{ sessions: object, rooms: object, messages: object, uploads: object, presence: object, clear: () => void }}
 */
export function createStore() {
  const store = {
    sessions: createSessionStore(),
    rooms: createRoomStore(),
    messages: createMessageStore(),
    uploads: createUploadStore(),
    presence: createPresenceStore(),
  };

  /** Wipe everything. Used by tests; production simply exits the process. */
  store.clear = () => {
    store.sessions.clear();
    store.rooms.clear();
    store.messages.clear();
    store.uploads.clear();
    store.presence.clear();
  };

  return store;
}

export { createSessionStore, createRoomStore, createMessageStore, createUploadStore, createPresenceStore };
