/**
 * The state of one filesystem entry, as the synchronisation engine sees it.
 *
 * Only regular files and directories are synchronised. Symbolic links, sockets,
 * FIFOs and devices are reported as `{ kind: 'other' }` and never cross the
 * wire: following a link could publish something outside the shared directory,
 * and recreating one on another machine rarely means the same thing.
 *
 * Two states are "the same" when they have the same kind and, for files, the
 * same size and modification time. That is the quick check rsync uses by
 * default, and it works because the receiving side always sets the mtime of a
 * file it writes to the sender's mtime.
 */
import { lstat } from 'node:fs/promises';
import { randomHex } from '../lib/ids.js';

/**
 * @typedef {object} EntryState
 * @property {'file'|'dir'} kind
 * @property {number} size Bytes; 0 for directories.
 * @property {number} mtimeMs Modification time, rounded to whole milliseconds.
 * @property {number} [ino] Inode number (local only, never sent to a peer).
 * @property {number} [dev] Device number (local only).
 */

/** Temporary files written while receiving: `.reptile-<hex>.tmp`. */
const TEMP_NAME = /^\.reptile-[0-9a-f]{8,32}\.tmp$/;

/** True for the name (not path) of one of Reptile's own temporary files. */
export function isTempName(name) {
  return TEMP_NAME.test(name);
}

/** True when the last segment of a wire path is a temporary file name. */
export function isTempPath(wirePath) {
  const index = wirePath.lastIndexOf('/');
  return isTempName(index === -1 ? wirePath : wirePath.slice(index + 1));
}

/** A fresh temporary file name. */
export function tempName() {
  return `.reptile-${randomHex(8)}.tmp`;
}

/**
 * Round an mtime to whole milliseconds.
 *
 * Why round instead of truncate: `utimes` takes seconds as a double, so an
 * mtime of ...123 ms written by the receiver can read back as ...122.9999 ms.
 * Truncating would turn that into a permanent one-millisecond mismatch.
 * @param {number} mtimeMs
 */
export function roundMtime(mtimeMs) {
  return Math.round(Number(mtimeMs) || 0);
}

/**
 * Convert `fs.Stats` into an entry state.
 * @param {import('node:fs').Stats} stats
 * @returns {EntryState|{ kind: 'other' }}
 */
export function stateFromStats(stats) {
  if (stats.isFile()) {
    return { kind: 'file', size: stats.size, mtimeMs: roundMtime(stats.mtimeMs), ino: stats.ino, dev: stats.dev };
  }
  if (stats.isDirectory()) {
    return { kind: 'dir', size: 0, mtimeMs: roundMtime(stats.mtimeMs), ino: stats.ino, dev: stats.dev };
  }
  return { kind: 'other' };
}

/**
 * Read the state of an absolute path without following symlinks.
 * @param {string} absolute
 * @returns {Promise<EntryState|{ kind: 'other' }|null>} null when nothing is there.
 */
export async function readState(absolute) {
  try {
    return stateFromStats(await lstat(absolute));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** True for states that take part in synchronisation. */
export function isSyncable(state) {
  return Boolean(state) && (state.kind === 'file' || state.kind === 'dir');
}

/**
 * Compare two states by content identity (kind, size, mtime).
 * Absent equals absent. Directories are equal to each other regardless of
 * mtime, which changes every time a child does and means nothing to a peer.
 * @param {EntryState|null|undefined} a
 * @param {EntryState|null|undefined} b
 */
export function sameState(a, b) {
  const left = isSyncable(a) ? a : null;
  const right = isSyncable(b) ? b : null;
  if (!left || !right) return !left && !right;
  if (left.kind !== right.kind) return false;
  if (left.kind === 'dir') return true;
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/**
 * Identity of an entry on this machine: device plus inode.
 *
 * A rename keeps the inode, which is how the watcher recognises "a disappeared
 * and b appeared" as one rename instead of a deletion and an upload.
 * @param {EntryState|import('node:fs').Stats|null|undefined} state
 * @returns {string|null}
 */
export function identityKey(state) {
  if (!state || state.ino === undefined || state.ino === null || state.dev === undefined) return null;
  return `${state.dev}:${state.ino}`;
}

/**
 * The part of a state that is meaningful to a peer.
 * @param {EntryState} state
 * @returns {{ kind: 'file'|'dir', size: number, mtimeMs: number }}
 */
export function publicState(state) {
  return { kind: state.kind, size: state.kind === 'file' ? state.size : 0, mtimeMs: state.mtimeMs };
}
