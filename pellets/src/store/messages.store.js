/**
 * Message history, per room, in memory.
 *
 * History is what a client receives when it joins a room, so that "a user who
 * enters a room that already has messages can read everything posted before
 * they arrived" holds. Messages are append-only: the specification forbids
 * editing and deleting them, so this store exposes no mutation API at all.
 */
export function createMessageStore() {
  /** @type {Map<string, object[]>} roomId -> chronological messages */
  const byRoom = new Map();

  return {
    /**
     * Append a message to a room.
     * @param {string} roomId
     * @param {object} message
     * @param {number} [maxPerRoom] 0 or less means unlimited (the default).
     */
    append(roomId, message, maxPerRoom = 0) {
      let list = byRoom.get(roomId);
      if (!list) {
        list = [];
        byRoom.set(roomId, list);
      }
      list.push(message);
      if (maxPerRoom > 0 && list.length > maxPerRoom) {
        // Drop the oldest entries; only reachable when an operator opted into
        // a cap through PELLETS_MAX_MESSAGES_PER_ROOM.
        list.splice(0, list.length - maxPerRoom);
      }
      return message;
    },

    /**
     * Full chronological history for a room.
     * @param {string} roomId
     * @param {{ limit?: number }} [options] Optional tail limit for clients that
     *   only want the most recent slice.
     * @returns {object[]} A copy; callers may sort or splice it freely.
     */
    history(roomId, options = {}) {
      const list = byRoom.get(roomId) || [];
      if (options.limit && options.limit > 0 && list.length > options.limit) {
        return list.slice(-options.limit);
      }
      return [...list];
    },

    /** Most recent message in a room, used for the Home list preview. */
    last(roomId) {
      const list = byRoom.get(roomId);
      return list && list.length ? list[list.length - 1] : null;
    },

    count(roomId) {
      const list = byRoom.get(roomId);
      return list ? list.length : 0;
    },

    /** Called when a room is deleted: its history dies with it. */
    dropRoom(roomId) {
      return byRoom.delete(roomId);
    },

    /** Total messages across every room. Exposed for /api/health. */
    total() {
      let sum = 0;
      for (const list of byRoom.values()) sum += list.length;
      return sum;
    },

    clear() {
      byRoom.clear();
    },
  };
}
