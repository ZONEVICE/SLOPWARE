/**
 * Identifier helpers built on Node's built-in `crypto` module.
 *
 * Pellets deliberately has no id library: `crypto.randomUUID()` is the RFC 4122
 * version 4 generator required by the specification.
 */
import { randomUUID, randomBytes } from 'node:crypto';

/** RFC 4122 v4 UUID, e.g. "1f0f0f2a-6c0e-4a5f-9d1a-6f2f7f9d0b11". */
export function uuid4() {
  return randomUUID();
}

/** Loose v4 UUID shape check, used to reject malformed ids coming from clients. */
export function isUuid4(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * Short url-safe token. Used for connection ids and upload filenames, where a
 * full UUID is unnecessarily long but collisions still must be impossible in
 * practice.
 * @param {number} [bytes]
 */
export function token(bytes = 12) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Monotonic-ish sortable id: millisecond timestamp + randomness.
 * Message ids use this so that a plain string sort equals chronological order,
 * even for two messages produced inside the same millisecond.
 */
let sequence = 0;
export function sortableId() {
  sequence = (sequence + 1) % 0x10000;
  const time = Date.now().toString(16).padStart(12, '0');
  const seq = sequence.toString(16).padStart(4, '0');
  return `${time}${seq}${randomBytes(4).toString('hex')}`;
}
