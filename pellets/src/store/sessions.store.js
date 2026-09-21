/**
 * Session records held in process memory.
 *
 * A session is created the first time a client touches the server and is never
 * written to disk. Restarting the process forgets every user.
 *
 * Shape of a session record:
 * {
 *   id: string,              // UUID v4, permanent, never changes
 *   displayName: string|null,// null until the client picks a username
 *   colorHue: number|null,   // assigned randomly when the username is picked
 *   theme: 'dark'|'light',   // server-side mirror of the client preference
 *   fingerprint: string|null,// hash of the client metadata, see middleware
 *   createdAt: number,
 *   lastSeenAt: number,
 *   userAgent: string
 * }
 */
import { Collection } from './collection.js';

export function createSessionStore() {
  const collection = new Collection({
    name: 'sessions',
    indexes: {
      // Lets a returning client be recognised when its cookie is gone.
      fingerprint: (session) => session.fingerprint || null,
    },
  });

  return {
    collection,

    /** @param {object} session Fully formed session record. */
    insert(session) {
      return collection.set(session.id, session);
    },

    /** @returns {object|undefined} */
    get(id) {
      return id ? collection.get(id) : undefined;
    },

    /** @returns {object|undefined} */
    getByFingerprint(fingerprint) {
      return collection.findBy('fingerprint', fingerprint);
    },

    /** Shallow merge; returns the updated record or null when unknown. */
    update(id, patch) {
      return collection.update(id, patch);
    },

    /** Refresh the activity timestamp without rewriting the whole record. */
    touch(id, at = Date.now()) {
      const session = collection.get(id);
      if (!session) return null;
      session.lastSeenAt = at;
      return session;
    },

    delete(id) {
      return collection.delete(id);
    },

    all() {
      return collection.all();
    },

    get size() {
      return collection.size;
    },

    clear() {
      collection.clear();
    },
  };
}
