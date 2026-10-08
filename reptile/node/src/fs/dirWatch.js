/**
 * Change hints from the operating system, straight from `fs.watch`.
 *
 * This module only answers "which paths may have changed?". It never reads
 * file states and never decides anything: `src/fs/watcher.js` lstat's every
 * hinted path and diffs it against the index. Keeping the hints cheap is the
 * whole point. A hint costs one string join and one Set insertion here, where
 * a higher-level watcher re-reads the whole directory and stats every entry in
 * it on each event, which made the receiving side of a live sync spend most of
 * its CPU time on bookkeeping that the diff below never needed.
 *
 * Two shapes, chosen per platform:
 *
 *  - Windows and macOS: ONE recursive `fs.watch` on the root. Both kernels
 *    watch a whole tree natively (ReadDirectoryChangesW, FSEvents), and on
 *    Windows a handle open on a subdirectory would stop the user from renaming
 *    its parent, so one handle on the root is also the polite choice there.
 *  - Linux (and anything else): one non-recursive `fs.watch` per directory,
 *    which is one inotify watch each. New directories are added by the owner
 *    as it discovers them (`add`), vanished ones are released (`remove`).
 *    Node's own recursive mode is not used on Linux: it is built in
 *    JavaScript on top of per-file watching, which is what this replaces.
 *
 * The inside of an unshared directory is never watched (`watchable`), but its
 * parent is, so renaming the unshared directory itself is still seen.
 */
import { watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { isTempName } from './entry.js';
import { baseName, joinWire, parentOf } from '../lib/wirePath.js';

/** Platforms whose `fs.watch` watches a whole tree natively. */
export const NATIVE_RECURSIVE = process.platform === 'win32' || process.platform === 'darwin';

/** Errors meaning "that directory is gone", not "watching is broken". */
const VANISHED = new Set(['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES']);

/**
 * @param {object} options
 * @param {string} options.root Absolute path of the watched tree.
 * @param {(dirWire: string) => boolean} [options.watchable] Whether to watch
 *   INSIDE this directory. The root is always watched.
 * @param {(wire: string) => void} options.onHint A path that may have changed.
 * @param {(dirWire: string) => void} options.onDirectory Something changed in
 *   this directory but the platform did not say what (no file name).
 * @param {(error: Error) => void} [options.onError] Watching failed in a way
 *   the user should know about (the inotify watch limit, typically).
 * @param {boolean} [options.recursive] One recursive watcher instead of one
 *   per directory; defaults to what the platform supports natively.
 */
export function createWatchTree({ root, watchable = () => true, onHint, onDirectory, onError, recursive = NATIVE_RECURSIVE }) {
  /** @type {Map<string, import('node:fs').FSWatcher>} directory wire path -> its watcher */
  const watchers = new Map();
  let closed = false;

  const absoluteOf = (wire) => (wire === '' ? root : join(root, ...wire.split('/')));

  const report = (error) => {
    if (closed) return;
    onError?.(error);
  };

  /** A per-directory event: `name` is a child's name, or the directory's own. */
  function onName(dirWire, name) {
    if (!name) {
      onDirectory(dirWire);
      return;
    }
    // inotify names the watched directory itself for events that concern it
    // (deleted, moved, attributes changed): look at both candidates. An
    // unchanged path costs one lstat in the batch and yields nothing.
    if (dirWire !== '' && name === baseName(dirWire)) onHint(dirWire);
    if (!isTempName(name)) onHint(joinWire(dirWire, name));
  }

  /** A recursive event: `relative` is a native path below the root. */
  function onRelative(relative) {
    if (!relative) {
      onDirectory('');
      return;
    }
    const segments = relative.split(sep === '\\' ? /[\\/]/ : '/').filter((segment) => segment && segment !== '.');
    if (segments.length === 0 || segments.includes('..')) return;
    if (isTempName(segments[segments.length - 1])) return;
    onHint(segments.join('/'));
  }

  /** Stop watching one directory (not its descendants). */
  function forget(dirWire, handle) {
    if (watchers.get(dirWire) !== handle) return;
    watchers.delete(dirWire);
    try {
      handle.close();
    } catch {
      /* already closed */
    }
  }

  /**
   * Watch one directory.
   * @param {string} dirWire
   * @returns {boolean} true when a NEW watcher was created. The owner should
   *   then look inside the directory: whatever was created there before the
   *   watcher existed produced no event.
   */
  function add(dirWire) {
    if (closed || recursive || watchers.has(dirWire)) return false;
    if (dirWire !== '' && !watchable(dirWire)) return false;
    let handle;
    try {
      handle = watch(absoluteOf(dirWire), { persistent: false }, (eventType, filename) => {
        if (closed || watchers.get(dirWire) !== handle) return;
        onName(dirWire, filename === null || filename === undefined ? '' : String(filename));
      });
    } catch (error) {
      if (!VANISHED.has(error.code)) report(error);
      return false;
    }
    handle.on('error', (error) => {
      forget(dirWire, handle);
      // A directory deleted while watched errors out on some platforms; the
      // batch sees the deletion through the parent's watcher anyway.
      if (!VANISHED.has(error?.code)) report(error);
      else onHint(dirWire);
    });
    watchers.set(dirWire, handle);
    return true;
  }

  /**
   * Stop watching a directory and everything below it (it was deleted, or
   * renamed away; the new location gets its own watchers).
   * @param {Iterable<string>} dirWires
   */
  function remove(dirWires) {
    if (recursive || watchers.size === 0) return;
    const gone = new Set(dirWires);
    if (gone.size === 0) return;
    for (const [path, handle] of [...watchers]) {
      for (let current = path; ; current = parentOf(current)) {
        if (gone.has(current)) {
          forget(path, handle);
          break;
        }
        if (current === '') break;
      }
    }
  }

  /**
   * Watch the whole tree. Resolves once every directory has its watcher, so
   * that the owner can build its index knowing nothing will be missed.
   */
  async function start() {
    if (recursive) {
      try {
        const handle = watch(root, { recursive: true, persistent: false }, (eventType, filename) => {
          if (closed) return;
          onRelative(filename === null || filename === undefined ? '' : String(filename));
        });
        handle.on('error', (error) => {
          // The root itself went away: let the batch find out and stop.
          if (VANISHED.has(error?.code)) onDirectory('');
          else report(error);
        });
        watchers.set('', handle);
      } catch (error) {
        report(error);
      }
      return;
    }

    // Breadth-first, a few directories at a time: a watcher is created
    // BEFORE its directory is listed, so nothing created meanwhile is lost.
    let queue = [''];
    while (queue.length > 0 && !closed) {
      const next = [];
      for (let index = 0; index < queue.length; index += 16) {
        await Promise.all(
          queue.slice(index, index + 16).map(async (dirWire) => {
            if (!add(dirWire) && dirWire !== '') return;
            let entries;
            try {
              entries = await readdir(absoluteOf(dirWire), { withFileTypes: true });
            } catch {
              return;
            }
            for (const entry of entries) {
              if (entry.isDirectory()) next.push(joinWire(dirWire, entry.name));
            }
          }),
        );
      }
      queue = next;
    }
  }

  return {
    start,
    add,
    remove,
    /** True when `dirWire` is covered by a watcher (always, when recursive). */
    has(dirWire) {
      return recursive ? watchers.size > 0 : watchers.has(dirWire);
    },
    /** Directories watched individually (0 or 1 when recursive). */
    get size() {
      return watchers.size;
    },
    /** True when one recursive watcher covers the whole tree. */
    recursive,
    /** Release every watcher that is not in `keep` (after a full rescan). */
    retain(keep) {
      if (recursive) return;
      for (const [path, handle] of [...watchers]) if (path !== '' && !keep.has(path)) forget(path, handle);
    },
    close() {
      closed = true;
      for (const [path, handle] of [...watchers]) forget(path, handle);
    },
  };
}
