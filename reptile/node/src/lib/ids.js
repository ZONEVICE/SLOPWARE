/**
 * Identifiers and secrets, all from `node:crypto`.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** A random UUIDv4, e.g. the per-process session id shown in the status bar. */
export function newUuid() {
  return randomUUID();
}

/** An unguessable bearer token for an authorised peer session. */
export function newToken() {
  return randomBytes(24).toString('hex');
}

/** Short random hex string, for temporary file names and log correlation. */
export function randomHex(bytes = 6) {
  return randomBytes(bytes).toString('hex');
}

/**
 * Constant-time string comparison.
 *
 * The PIN is openly a symbolic secret, but there is no reason to leak it
 * through timing either, and this costs nothing.
 * @param {string} a
 * @param {string} b
 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
