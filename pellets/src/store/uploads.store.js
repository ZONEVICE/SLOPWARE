/**
 * Metadata for uploaded attachments.
 *
 * IMPORTANT ASYMMETRY: the bytes live on disk under `uploads/` and survive a
 * restart, but this metadata index does not. That is intentional. After a
 * restart an orphaned file is still readable by its stored name, yet it is
 * listed nowhere, because the chat that referenced it no longer exists.
 *
 * Shape of an upload record:
 * {
 *   id: string,          // UUID v4
 *   storedName: string,  // name on disk: "<id><ext>"
 *   name: string,        // original filename as provided by the client
 *   mime: string,
 *   kind: 'image'|'video'|'file',
 *   size: number,
 *   url: string,         // "/uploads/<storedName>"
 *   ownerId: string,     // session that uploaded it
 *   createdAt: number,
 *   attached: boolean    // true once a message references it
 * }
 */
import { Collection } from './collection.js';

export function createUploadStore() {
  const collection = new Collection({
    name: 'uploads',
    indexes: {
      storedName: (upload) => upload.storedName || null,
    },
  });

  return {
    collection,

    insert(upload) {
      return collection.set(upload.id, upload);
    },

    get(id) {
      return id ? collection.get(id) : undefined;
    },

    getByStoredName(storedName) {
      return collection.findBy('storedName', storedName);
    },

    update(id, patch) {
      return collection.update(id, patch);
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
