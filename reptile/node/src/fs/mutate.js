/**
 * Disk mutations performed on behalf of a peer.
 *
 * Every function takes the synced root and a wire path that has already been
 * normalised by `normalizeWirePath`. On top of the lexical containment check in
 * `resolveWirePath`, these functions refuse to traverse a symbolic link on the
 * way to the target: a link inside the shared directory pointing at /etc must
 * not let a peer write to /etc.
 *
 * Files are received in two phases (`stageFile` then `commit`) so that the
 * caller can take its lock only for the instant the file is renamed into place,
 * not for the whole transfer.
 */
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, rmdir, unlink, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isTempName, readState, tempName } from './entry.js';
import { joinWire, parentOf, resolveWirePath } from '../lib/wirePath.js';

/** An error with a machine code, thrown for conditions the peer should learn about. */
export function fsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Resolve a wire path and verify that every EXISTING ancestor between the root
 * and the target is a real directory, not a symlink or a file.
 * @param {string} root
 * @param {string} wirePath
 * @returns {Promise<string>} Absolute path of the target.
 */
export async function resolveSafely(root, wirePath) {
  const target = resolveWirePath(root, wirePath);
  if (wirePath === '') return target;
  const segments = wirePath.split('/');
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = join(current, segments[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return target; // the rest will be created
      throw error;
    }
    if (info.isSymbolicLink()) throw fsError('unsafe_path', `Refusing to follow a symbolic link at ${segments.slice(0, index + 1).join('/')}.`);
    if (!info.isDirectory()) throw fsError('conflict', `${segments.slice(0, index + 1).join('/')} is a file, not a directory.`);
  }
  return target;
}

/**
 * Create a directory and any missing parents, one level at a time, never
 * through a symlink.
 * @param {string} root
 * @param {string} wirePath
 * @returns {Promise<{ path: string, state: object }[]>} The directories that were created, parents first.
 */
export async function ensureDirectory(root, wirePath) {
  const created = [];
  if (wirePath === '') return created;
  const segments = wirePath.split('/');
  let wire = '';
  for (const segment of segments) {
    wire = joinWire(wire, segment);
    const absolute = resolveWirePath(root, wire);
    let state = await readState(absolute);
    if (!state) {
      try {
        await mkdir(absolute);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      state = await readState(absolute);
      if (state?.kind === 'dir') {
        created.push({ path: wire, state });
        continue;
      }
    }
    if (state?.kind !== 'dir') {
      throw fsError('conflict', `${wire} exists and is not a directory.`);
    }
  }
  return created;
}

/**
 * Receive a file into a temporary name next to its destination.
 *
 * Writes `source` to `.reptile-<hex>.tmp` in the target's directory, checks
 * the byte count, and stamps the sender's mtime on it. Nothing at the target
 * path changes until `commit()` renames the temporary file into place, which
 * is atomic on the same filesystem, so a reader never sees half a file.
 *
 * @param {string} root
 * @param {string} wirePath
 * @param {import('node:stream').Readable} source
 * @param {{ mtimeMs: number, size?: number|null }} meta
 * @returns {Promise<{ state: object, tempPath: string, targetPath: string, commit: () => Promise<void>, discard: () => Promise<void> }>}
 */
export async function stageFile(root, wirePath, source, meta) {
  const targetPath = await resolveSafely(root, wirePath);
  const tempPath = join(dirname(targetPath), tempName());
  const discard = () => rm(tempPath, { force: true });

  try {
    await pipeline(source, createWriteStream(tempPath, { flags: 'wx' }));
    const written = (await lstat(tempPath)).size;
    if (Number.isFinite(meta.size) && meta.size !== null && written !== meta.size) {
      throw fsError('size_mismatch', `Expected ${meta.size} bytes but received ${written}.`);
    }
    const when = new Date(meta.mtimeMs);
    await utimes(tempPath, when, when);
    const state = await readState(tempPath);

    return {
      state,
      tempPath,
      targetPath,
      discard,
      /** Rename into place. Refuses to replace a directory. */
      async commit() {
        const existing = await readState(targetPath);
        if (existing?.kind === 'dir') throw fsError('conflict', `${wirePath} is a directory.`);
        if (existing?.kind === 'other') throw fsError('conflict', `${wirePath} is a special file or a link.`);
        await rename(tempPath, targetPath);
      },
    };
  } catch (error) {
    await discard();
    throw error;
  }
}

/**
 * Delete one file. A file that is already gone is not an error.
 * @returns {Promise<boolean>} true when something was deleted.
 */
export async function removeFile(root, wirePath) {
  const target = await resolveSafely(root, wirePath);
  try {
    await unlink(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (error.code === 'EISDIR' || error.code === 'EPERM') {
      const state = await readState(target);
      if (state?.kind === 'dir') throw fsError('conflict', `${wirePath} is a directory.`);
    }
    throw error;
  }
}

/**
 * Remove a directory tree, but only the entries `shouldRemove` approves.
 *
 * Works bottom-up: files first, then each directory once it is empty. A
 * directory that still holds something (an unshared item, a file modified
 * since the peer last saw it, a symlink) is kept, and so are its ancestors.
 *
 * @param {string} root
 * @param {string} wirePath
 * @param {{ shouldRemove?: (wirePath: string, state: object) => boolean }} [options]
 * @returns {Promise<{ removed: string[], kept: string[] }>}
 */
export async function removeTree(root, wirePath, options = {}) {
  const shouldRemove = options.shouldRemove || (() => true);
  const removed = [];
  const kept = [];
  const top = await resolveSafely(root, wirePath);
  const topState = await readState(top);
  if (!topState) return { removed, kept };
  if (topState.kind !== 'dir') throw fsError('conflict', `${wirePath} is not a directory.`);

  const visit = async (wire) => {
    const absolute = resolveWirePath(root, wire);
    let names;
    try {
      names = await readdir(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      kept.push(wire);
      return false;
    }
    let empty = true;
    for (const name of names) {
      const child = joinWire(wire, name);
      const state = await readState(join(absolute, name));
      if (!state) continue;
      if (isTempName(name) || state.kind === 'other') {
        kept.push(child);
        empty = false;
        continue;
      }
      if (state.kind === 'dir') {
        if (!(await visit(child))) empty = false;
        continue;
      }
      if (shouldRemove(child, state)) {
        await unlink(join(absolute, name)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        removed.push(child);
      } else {
        kept.push(child);
        empty = false;
      }
    }
    if (!empty || !shouldRemove(wire, await readState(absolute))) {
      if (empty) kept.push(wire);
      return false;
    }
    try {
      await rmdir(absolute);
      removed.push(wire);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') {
        kept.push(wire);
        return false;
      }
      throw error;
    }
  };

  await visit(wirePath);
  return { removed, kept };
}

/**
 * Rename a file or directory inside the root, creating the destination's
 * parents as needed.
 * @returns {Promise<{ path: string, state: object }[]>} Parent directories created.
 */
export async function moveEntry(root, from, to) {
  const source = await resolveSafely(root, from);
  const created = await ensureDirectory(root, parentOf(to));
  const target = await resolveSafely(root, to);
  const sourceState = await readState(source);
  if (!sourceState) throw fsError('not_found', `${from} does not exist.`);
  const targetState = await readState(target);
  if (targetState && (targetState.kind === 'dir' || sourceState.kind === 'dir')) {
    throw fsError('conflict', `${to} already exists.`);
  }
  await rename(source, target);
  return created;
}

/**
 * Move a directory's content to a new location entry by entry, leaving behind
 * whatever `canMove` refuses.
 *
 * The host uses this when a peer renames a directory that also contains
 * unshared items: those must not move, because "unchecked items are never
 * modified from the other side". Everything else moves, and the source
 * directory is removed if it ends up empty.
 *
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @param {{ canMove: (wirePath: string, state: object) => boolean }} options
 * @returns {Promise<{ moved: [string, string][], kept: string[] }>}
 */
export async function moveTreeSelective(root, from, to, { canMove }) {
  const moved = [];
  const kept = [];
  await ensureDirectory(root, to);

  const visit = async (sourceWire, targetWire) => {
    const absolute = resolveWirePath(root, sourceWire);
    const names = await readdir(absolute).catch(() => []);
    let empty = true;
    for (const name of names) {
      const child = joinWire(sourceWire, name);
      const destination = joinWire(targetWire, name);
      const state = await readState(join(absolute, name));
      if (!state) continue;
      if (state.kind === 'other' || isTempName(name) || !canMove(child, state)) {
        kept.push(child);
        empty = false;
        continue;
      }
      if (state.kind === 'dir') {
        await ensureDirectory(root, destination);
        if (!(await visit(child, destination))) empty = false;
        continue;
      }
      const targetState = await readState(resolveWirePath(root, destination));
      if (targetState?.kind === 'dir') {
        kept.push(child);
        empty = false;
        continue;
      }
      await rename(join(absolute, name), resolveWirePath(root, destination));
      moved.push([child, destination]);
    }
    if (!empty) return false;
    try {
      await rmdir(absolute);
      return true;
    } catch {
      kept.push(sourceWire);
      return false;
    }
  };

  await visit(from, to);
  return { moved, kept };
}

/** Set a file's modification time (and access time) to `mtimeMs`. */
export async function setMtime(root, wirePath, mtimeMs) {
  const target = await resolveSafely(root, wirePath);
  const when = new Date(mtimeMs);
  await utimes(target, when, when);
  return readState(target);
}

/**
 * Delete temporary files left behind by an interrupted transfer. Safe to run
 * whenever no transfer is in flight, which is the case when hosting or
 * syncing starts.
 * @param {string} root
 * @returns {Promise<number>} How many were removed.
 */
export async function removeStaleTempFiles(root) {
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && isTempName(entry.name)) {
        await rm(absolute, { force: true });
        count += 1;
      }
    }
  }
  return count;
}

