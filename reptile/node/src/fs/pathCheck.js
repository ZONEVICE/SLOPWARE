/**
 * Validation of the directories the user types into the interface.
 *
 * The interface calls these on every pause in typing, so the messages are
 * written for a person and each result says exactly one thing that is wrong,
 * or what will happen when the directory is used.
 */
import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isTempName } from './entry.js';

/**
 * @typedef {object} PathCheck
 * @property {boolean} ok
 * @property {string} code Machine-readable outcome.
 * @property {string} message Human-readable outcome.
 * @property {string} [path] Canonical absolute path, when one could be determined.
 * @property {number} [entries] Number of visible entries at the top level.
 * @property {boolean} [exists]
 * @property {boolean} [empty]
 */

function describePermission(error) {
  return error && (error.code === 'EACCES' || error.code === 'EPERM');
}

/** Count top-level entries, ignoring Reptile's own temporary files. */
async function countEntries(path) {
  const names = await readdir(path);
  return names.filter((name) => !isTempName(name)).length;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Check a directory the user wants to host: it must exist, be a directory, and
 * have readable contents.
 * @param {unknown} input
 * @returns {Promise<PathCheck>}
 */
export async function checkHostDirectory(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { ok: false, code: 'empty', message: 'Type the absolute path of the directory to host.' };
  if (!isAbsolute(raw)) {
    return { ok: false, code: 'not_absolute', message: 'The path must be absolute, starting from the root (for example /home/you/Documents).' };
  }

  let info;
  try {
    info = await stat(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, code: 'not_found', message: 'Nothing exists at this path.' };
    if (error.code === 'ENOTDIR') return { ok: false, code: 'not_found', message: 'A parent of this path is a file, so the path cannot exist.' };
    if (describePermission(error)) return { ok: false, code: 'permission', message: 'Permission denied while looking up this path.' };
    return { ok: false, code: 'error', message: error.message };
  }
  if (!info.isDirectory()) return { ok: false, code: 'not_directory', message: 'This path is a file, not a directory.' };

  let canonical;
  try {
    canonical = await realpath(raw);
  } catch {
    canonical = resolve(raw);
  }

  try {
    await access(canonical, constants.R_OK | constants.X_OK);
    const entries = await countEntries(canonical);
    return {
      ok: true,
      code: 'ok',
      path: canonical,
      entries,
      message: entries === 0 ? 'Readable directory. It is empty.' : `Readable directory with ${plural(entries, 'item')} at the top level.`,
    };
  } catch (error) {
    if (describePermission(error)) {
      return { ok: false, code: 'unreadable', path: canonical, message: 'The directory exists, but its contents cannot be read (permission denied).' };
    }
    return { ok: false, code: 'error', path: canonical, message: error.message };
  }
}

/**
 * Check the local directory a synced copy will be written to. It may exist
 * (and must then be a writable directory) or be created (its nearest existing
 * parent must then be a writable directory).
 * @param {unknown} input
 * @returns {Promise<PathCheck>}
 */
export async function checkSyncDirectory(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { ok: false, code: 'empty', message: 'Type the absolute path where the synced directory will be stored.' };
  if (!isAbsolute(raw)) {
    return { ok: false, code: 'not_absolute', message: 'The path must be absolute, starting from the root (for example /home/you/Synced).' };
  }
  const target = resolve(raw);
  if (dirname(target) === target) {
    return { ok: false, code: 'root', message: 'The filesystem root cannot be used as a synced directory.' };
  }

  let info = null;
  try {
    info = await stat(target);
  } catch (error) {
    if (describePermission(error)) return { ok: false, code: 'permission', message: 'Permission denied while looking up this path.' };
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return { ok: false, code: 'error', message: error.message };
  }

  if (info) {
    if (!info.isDirectory()) return { ok: false, code: 'not_directory', message: 'This path is a file, not a directory.' };
    const canonical = await realpath(target).catch(() => target);
    try {
      await access(canonical, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch {
      return { ok: false, code: 'not_writable', path: canonical, message: 'The directory exists, but you cannot write to it.' };
    }
    let entries;
    try {
      entries = await countEntries(canonical);
    } catch {
      return { ok: false, code: 'unreadable', path: canonical, message: 'The directory exists, but its contents cannot be read.' };
    }
    return {
      ok: true,
      code: entries === 0 ? 'empty_directory' : 'existing_directory',
      path: canonical,
      exists: true,
      empty: entries === 0,
      entries,
      message:
        entries === 0
          ? 'Empty directory. The host’s files will be copied here.'
          : `Existing directory with ${plural(entries, 'item')}. Its content will be merged with the host’s: ` +
            'anything missing on either side is copied, and where both have a different version the newer one wins.',
    };
  }

  // Walk up to the nearest existing ancestor.
  let ancestor = dirname(target);
  for (;;) {
    try {
      const ancestorInfo = await stat(ancestor);
      if (!ancestorInfo.isDirectory()) {
        return { ok: false, code: 'parent_not_directory', message: `${ancestor} is a file, so this directory cannot be created.` };
      }
      break;
    } catch (error) {
      if (describePermission(error)) return { ok: false, code: 'permission', message: `Permission denied on ${ancestor}.` };
      const parent = dirname(ancestor);
      if (parent === ancestor) return { ok: false, code: 'error', message: 'No existing parent directory was found.' };
      ancestor = parent;
    }
  }
  try {
    await access(ancestor, constants.W_OK | constants.X_OK);
  } catch {
    return { ok: false, code: 'not_writable', message: `The directory cannot be created: you cannot write to ${ancestor}.` };
  }
  const canonicalAncestor = await realpath(ancestor).catch(() => ancestor);
  const rest = target.slice(ancestor.length).replace(/^[\\/]+/, '');
  return {
    ok: true,
    code: 'will_create',
    path: rest ? join(canonicalAncestor, rest) : canonicalAncestor,
    exists: false,
    empty: true,
    entries: 0,
    message: 'This directory does not exist yet. It will be created when the sync starts.',
  };
}

/**
 * True when one absolute path is the other or contains it. Used to refuse
 * syncing a directory into itself on the same machine.
 * @param {string} a
 * @param {string} b
 */
export function pathsOverlap(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  const within = (outer, inner) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
  return within(left, right) || within(right, left);
}
