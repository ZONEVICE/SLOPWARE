/**
 * Chat rooms held in process memory.
 *
 * Shape of a room record:
 * {
 *   id: string,          // UUID v4, used in the /room/<id> URL
 *   name: string,
 *   topic: string,
 *   createdBy: string,   // session id; ONLY this session may delete the room
 *   createdByName: string,
 *   createdAt: number
 * }
 *
 * A room with nobody in it stays open and stays listed, as the specification
 * requires. Rooms disappear only when their creator deletes them, or when the
 * process exits.
 */
import { Collection } from './collection.js';

export function createRoomStore() {
  const collection = new Collection({ name: 'rooms' });

  return {
    collection,

    insert(room) {
      return collection.set(room.id, room);
    },

    get(id) {
      return id ? collection.get(id) : undefined;
    },

    has(id) {
      return Boolean(id) && collection.has(id);
    },

    update(id, patch) {
      return collection.update(id, patch);
    },

    delete(id) {
      return collection.delete(id);
    },

    /** Newest rooms first: the Home list reads top-down. */
    all() {
      return collection.all().sort((a, b) => b.createdAt - a.createdAt);
    },

    get size() {
      return collection.size;
    },

    clear() {
      collection.clear();
    },
  };
}
