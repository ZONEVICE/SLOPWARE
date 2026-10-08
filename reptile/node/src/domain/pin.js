/**
 * The PIN: four digits, the only protection Reptile has.
 *
 * It is deliberately symbolic. There is no attempt limit and no lockout; the
 * specification says so explicitly. What the PIN does guarantee is that a peer
 * cannot connect by accident, and that changing it cuts off whoever is
 * connected until they type the new one.
 */
import { randomInt } from 'node:crypto';
import { errors } from './errors.js';
import { safeEqual } from '../lib/ids.js';

/** Exactly four ASCII digits. */
export const PIN_PATTERN = /^\d{4}$/;

/** A random PIN, zero-padded: "0042" is as valid as "4242". */
export function generatePin() {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

/**
 * Validate a PIN typed by the user.
 * @param {unknown} value
 * @returns {string} The PIN.
 * @throws {import('./errors.js').AppError}
 */
export function assertPin(value) {
  const pin = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!PIN_PATTERN.test(pin)) throw errors.badRequest('The PIN must be exactly 4 digits.', 'pin_format');
  return pin;
}

/**
 * Compare a candidate with the current PIN in constant time.
 * @param {unknown} candidate
 * @param {string} actual
 */
export function pinMatches(candidate, actual) {
  return typeof candidate === 'string' && PIN_PATTERN.test(candidate) && safeEqual(candidate, actual);
}
