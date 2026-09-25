/**
 * Filesystem watcher and change detector.
 *
 * chokidar reports events: "add", "change", "unlink", "addDir", "unlinkDir",
 * plus the "raw" fs.watch notifications underneath them. They cannot be
 * forwarded to a peer as they are:
 *
 *  - chokidar has no rename event. Renaming "a" to "b" arrives as "unlink a"
 *    plus "add b", in either order and possibly far apart (the add waits for
 *    the write to settle). Forwarding them literally would delete the file on
 *    the peer and upload it again.
 *  - A change applied on behalf of the peer produces events too. Forwarding
 *    those would bounce every change back and forth forever.
 *
 * So events are only used as hints about WHICH paths to look at. Each batch
 * compares what is on disk now with the index (the state last known to be in
 * sync) and derives operations from the difference:
 *
 *   disk has it, index does not          -> mkdir / write
 *   index has it, disk does not          -> unlink / rmdir (held back briefly)
 *   file on both, size or mtime differs  -> write
 *   a new path holds the inode of a path
 *   that is gone                          -> rename (a directory's children
 *                                            move with it)
 *
 * Echo suppression falls out of this for free: whoever applies a peer's change
 * updates the index first, so the resulting events find nothing to report.
 *
 * Removals are held for `renameWindowMs` before being reported, because the
 * other half of a rename may still be on its way. A rename detected inside that
 * window cancels the removal.
 *
 * Belt and braces. chokidar's high-level events are not enough on their own:
 * when two reads of the same directory overlap, chokidar can drop a file it
 * was about to report and then never report its deletion either (see
 * CLAUDE.md, "Things that cost time"). Four extra hints make detection
 * independent of that bookkeeping:
 *   1. every raw fs.watch notification touches the path it names;
 *   2. a new or renamed directory is walked, so files created inside it
 *      before any watcher existed are examined too;
 *   3. a file modified in the last `stabilityMs` is re-examined later rather
 *      than sent half-written (chokidar's own write-finish wait is bypassed
 *      by raw hints);
 *   4. every `rescanIntervalMs` the whole tree is compared with the index.
 */
import { lstat, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { watch } from 'chokidar';
import { identityKey, isSyncable, isTempName, readState, sameState, stateFromStats } from './entry.js';
import { depthOf, isStrictlyInside, joinWire, rebase, resolveWirePath, sortWirePaths, wirePathOf } from '../lib/wirePath.js';

/**
 * A copy-on-write view over a FileIndex. A batch applies the renames and
 * additions it detects to the view, so later paths in the same batch are
 * compared against the state the peer will have after those operations,
 * while the real index only changes once the owner commits.
 */
class IndexView {
  /** @param {import('./fileIndex.js').FileIndex} index */
  constructor(index) {
    this.index = index;
    /** @type {Map<string, object|null>} */
    this.overlay = new Map();
  }

  get(path) {
    return this.overlay.has(path) ? this.overlay.get(path) : this.index.get(path);
  }

  set(path, state) {
    this.overlay.set(path, state);
  }

  /** Entries strictly below `path`, overlay first. */
  descendants(path) {
    const out = new Map();
    for (const [child, state] of this.index.descendants(path)) {
      if (!this.overlay.has(child)) out.set(child, state);
    }
    for (const [child, state] of this.overlay) {
      if (state && isStrictlyInside(path, child)) out.set(child, state);
    }
    return out;
  }

  deleteTree(path) {
    for (const [child] of this.descendants(path)) this.overlay.set(child, null);
    this.overlay.set(path, null);
  }

  rekey(from, to) {
    const moving = [];
    const own = this.get(from);
    if (own) moving.push([from, own]);
    for (const entry of this.descendants(from)) moving.push(entry);
    for (const [path] of moving) this.overlay.set(path, null);
    this.deleteTree(to);
    for (const [path, state] of moving) this.overlay.set(rebase(path, from, to), state);
  }
}

/** Run `fn` over `items` with bounded parallelism. */
async function forEachLimit(items, limit, fn) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
}

/**
 * @typedef {object} SyncOp
 * @property {'mkdir'|'write'|'unlink'|'rmdir'|'rename'|'reindex'} op
 *   `reindex` is local bookkeeping only (same content, new inode) and is
 *   never sent to a peer.
 * @property {string} [path]
 * @property {string} [from]
 * @property {string} [to]
 * @property {'file'|'dir'} [kind] For renames.
 * @property {object} [state] New local state (with inode) for commits.
 * @property {object|null} [base] Previous indexed state, for conflict checks.
 */

/**
 * Watch a directory and report batches of operations.
 *
 * @param {object} options
 * @param {string} options.root Absolute path to watch.
 * @param {import('./fileIndex.js').FileIndex} options.index Baseline to diff against. Never mutated here.
 * @param {(ops: SyncOp[]) => Promise<void>|void} options.onOps Receives each non-empty batch, in order.
 * @param {(wirePath: string, stats?: import('node:fs').Stats) => boolean} [options.ignore]
 *   Paths that must never be watched or reported.
 * @param {(wirePath: string, stats?: import('node:fs').Stats) => void} [options.onRawAdd]
 *   Called synchronously for every add/addDir event, before any batching.
 * @param {(fn: () => Promise<void>) => Promise<void>} [options.run]
 *   Executes batch processing; pass a serial queue or a mutex so batches never
 *   interleave with the owner's own disk changes.
 * @param {() => void} [options.onRootMissing] The watched directory vanished.
 * @param {(error: Error) => void} [options.onError]
 * @param {number} [options.quietMs] Wait this long after the last event.
 * @param {number} [options.maxWaitMs] ...but never longer than this after the first one.
 * @param {number} [options.renameWindowMs] How long a removal is held back.
 * @param {number} [options.stabilityMs] A written file must stay unchanged this long.
 * @param {number} [options.rescanIntervalMs] Full comparison period; 0 disables it.
 * @param {boolean} [options.usePolling]
 * @param {object} [options.logger]
 */
export function createDirectoryWatcher(options) {
  const {
    root,
    index,
    onOps,
    ignore = () => false,
    onRawAdd,
    run = (fn) => fn(),
    onRootMissing,
    onError,
    quietMs = 150,
    maxWaitMs = 1000,
    renameWindowMs = 1200,
    stabilityMs = 300,
    rescanIntervalMs = 5 * 60_000,
    usePolling = false,
    logger,
  } = options;

  const touched = new Set();
  /** @type {Map<string, number>} wire path -> when it was first seen missing */
  const pendingRemovals = new Map();
  /** @type {Map<string, number>} how many times a still-changing file was put off */
  const deferrals = new Map();
  let firstTouchAt = 0;
  let lastTouchAt = 0;
  let nextRemovalDue = 0;
  let nextRetryDue = 0;
  let timer = null;
  let closed = false;
  let chain = Promise.resolve();

  const toWire = (absolute) => wirePathOf(root, absolute);
  const visible = (wire) => wire !== null && wire !== '' && !ignore(wire);

  const watcher = watch(root, {
    ignoreInitial: true,
    followSymlinks: false,
    // chokidar's "atomic" mode silently ignores editor swap and backup files
    // (*.swp, *~) and rewrites unlink+add into change. The batch logic below
    // already handles atomic saves, and every file must be treated alike.
    atomic: false,
    awaitWriteFinish: { stabilityThreshold: stabilityMs, pollInterval: Math.max(20, Math.floor(stabilityMs / 3)) },
    ignorePermissionErrors: true,
    usePolling,
    interval: 100,
    ignored: (absolute, stats) => {
      const wire = toWire(absolute);
      if (wire === null || wire === '') return false;
      return ignore(wire, stats);
    },
  });

  const ready = new Promise((resolve) => watcher.once('ready', resolve));

  watcher.on('all', (event, absolute, stats) => {
    if (closed) return;
    const wire = toWire(absolute);
    if (!wire) return;
    if ((event === 'add' || event === 'addDir') && onRawAdd) {
      try {
        onRawAdd(wire, stats);
      } catch (error) {
        logger?.error?.('onRawAdd failed:', error);
      }
    }
    touch(wire);
  });

  // Hint 1: the fs.watch notifications themselves. For a directory watcher
  // `path` is a child name; for a file watcher it is the file's own name.
  // Touching both candidates is harmless: an unchanged path yields nothing.
  watcher.on('raw', (event, path, details) => {
    if (closed || !path) return;
    const watched = details?.watchedPath;
    const candidates = [];
    if (isAbsolute(path)) candidates.push(path);
    else if (watched) {
      // A file watcher reports its own name; a directory watcher reports a
      // child's. When the name matches the watched path, the index usually
      // says which one it is; only an unknown path gets both candidates.
      const known = basename(watched) === path ? index.get(toWire(watched) ?? '')?.kind : 'dir';
      if (known !== 'file') candidates.push(join(watched, path));
      if (basename(watched) === path && known !== 'dir') candidates.push(watched);
    }
    for (const candidate of candidates) {
      if (isTempName(basename(candidate))) continue;
      const wire = toWire(candidate);
      if (visible(wire)) touch(wire);
    }
  });

  watcher.on('error', (error) => {
    logger?.warn?.('watcher error:', error?.message || error);
    onError?.(error);
  });

  // Hint 4: a periodic full comparison, for anything every watcher missed
  // (an inotify queue overflow under a flood of changes, for instance).
  const rescanTimer =
    rescanIntervalMs > 0
      ? setInterval(() => {
          rescan().catch((error) => logger?.warn?.('rescan failed:', error.message));
        }, rescanIntervalMs)
      : null;
  rescanTimer?.unref?.();

  function reschedule() {
    if (closed) return;
    let due = Infinity;
    if (touched.size > 0) due = Math.min(lastTouchAt + quietMs, firstTouchAt + maxWaitMs);
    if (pendingRemovals.size > 0 && nextRemovalDue) due = Math.min(due, nextRemovalDue);
    if (nextRetryDue) due = Math.min(due, nextRetryDue);
    if (due === Infinity) return;
    clearTimeout(timer);
    timer = setTimeout(fire, Math.max(0, due - Date.now()));
  }

  /** Mark a path for re-examination. Public so owners can force a re-check. */
  function touch(wire) {
    const now = Date.now();
    touched.add(wire);
    if (!firstTouchAt) firstTouchAt = now;
    lastTouchAt = now;
    reschedule();
  }

  function fire() {
    timer = null;
    chain = chain
      .then(() => run(processBatch))
      .catch((error) => logger?.error?.('change batch failed:', error))
      .finally(() => reschedule());
    return chain;
  }

  /** Compare the whole tree with the index and touch every difference. */
  async function rescan() {
    if (closed) return 0;
    const seen = new Set();
    let differences = 0;
    const stack = [''];
    while (stack.length > 0) {
      const directory = stack.pop();
      let names;
      try {
        names = await readdir(resolveWirePath(root, directory));
      } catch {
        continue;
      }
      for (const name of names) {
        if (isTempName(name)) continue;
        const wire = joinWire(directory, name);
        if (!visible(wire)) continue;
        let state;
        try {
          state = stateFromStats(await lstat(resolveWirePath(root, wire)));
        } catch {
          continue;
        }
        if (!isSyncable(state)) continue;
        seen.add(wire);
        if (!sameState(index.get(wire), state)) {
          touch(wire);
          differences += 1;
        }
        if (state.kind === 'dir') stack.push(wire);
      }
    }
    for (const [wire] of index.entries) {
      if (!seen.has(wire) && visible(wire)) {
        touch(wire);
        differences += 1;
      }
    }
    if (differences > 0) logger?.debug?.(`rescan found ${differences} difference(s)`);
    return differences;
  }

  async function processBatch() {
    if (closed) return;
    const startedAt = Date.now();
    const candidates = new Set(touched);
    touched.clear();
    firstTouchAt = 0;
    lastTouchAt = 0;
    nextRetryDue = 0;
    for (const path of pendingRemovals.keys()) candidates.add(path);
    if (candidates.size === 0) return;

    // A vanished root (deleted, or a drive unmounted) must never be read as
    // "every file was deleted": that would wipe the peer's copy too.
    const rootState = await readState(root).catch(() => null);
    if (!rootState || rootState.kind !== 'dir') {
      pendingRemovals.clear();
      onRootMissing?.();
      return;
    }

    /** @type {Map<string, object|null>} */
    const disk = new Map();
    const look = async (path) => {
      if (disk.has(path)) return disk.get(path);
      let state = null;
      if (!ignore(path)) {
        try {
          state = await readState(resolveWirePath(root, path));
        } catch {
          state = null;
        }
        if (!isSyncable(state)) state = null;
      }
      disk.set(path, state);
      return state;
    };
    await forEachLimit([...candidates], 64, look);

    /** Hint 2: add everything below a directory as candidates. */
    const expand = async (directory) => {
      const stack = [directory];
      while (stack.length > 0) {
        const current = stack.pop();
        let names;
        try {
          names = await readdir(resolveWirePath(root, current));
        } catch {
          continue;
        }
        for (const name of names) {
          if (isTempName(name)) continue;
          const child = joinWire(current, name);
          if (!visible(child)) continue;
          candidates.add(child);
          const state = await look(child);
          if (state?.kind === 'dir') stack.push(child);
        }
      }
    };

    // A directory that vanished (or turned into a file) takes its indexed
    // descendants with it, whether or not chokidar reported each of them.
    for (const path of [...candidates]) {
      if (index.get(path)?.kind === 'dir' && disk.get(path)?.kind !== 'dir') {
        for (const [child] of index.descendants(path)) {
          if (!candidates.has(child)) {
            candidates.add(child);
            disk.set(child, null);
          }
        }
      }
    }

    const view = new IndexView(index);
    /** @type {SyncOp[]} */
    const renames = [];

    // --- Phase A: renames, recognised by device + inode ----------------------
    // Parents first, so that a renamed directory is found before its children,
    // which then compare equal in the view and are not reported again.
    for (const path of sortWirePaths(candidates)) {
      const now = disk.get(path);
      if (!now) continue;
      const key = identityKey(now);
      const known = view.get(path);
      if (known && identityKey(known) === key) continue;
      const from = index.pathForIdentity(key);
      if (!from || from === path) continue;
      const previous = view.get(from);
      if (!previous || identityKey(previous) !== key || previous.kind !== now.kind) continue;
      if (now.kind === 'file' && (previous.size !== now.size || previous.mtimeMs !== now.mtimeMs)) continue;
      // A hard link keeps both names alive; that is an addition, not a move.
      const stillThere = await look(from);
      if (stillThere && identityKey(stillThere) === key) continue;

      renames.push({ op: 'rename', from, to: path, kind: now.kind, state: now });
      view.rekey(from, path);
      view.set(path, now);
      pendingRemovals.delete(from);
      // Something new may already live at the old location.
      candidates.add(from);
      if (now.kind === 'dir') {
        // The children moved along. Check each at its new location so a file
        // changed, deleted or added during the move is still noticed.
        const children = [...view.descendants(path).keys()];
        for (const child of children) candidates.add(child);
        await forEachLimit(children, 64, look);
        await expand(path);
      }
    }

    // New directories, including one that replaced a file: examine their
    // content too (hint 2).
    for (const path of [...candidates]) {
      if (disk.get(path)?.kind === 'dir' && view.get(path)?.kind !== 'dir') await expand(path);
    }

    // --- Phase B: additions, modifications, replacements ---------------------
    /** @type {SyncOp[]} */
    const changes = [];
    const removalCandidates = [];
    const retry = [];
    for (const path of sortWirePaths(candidates)) {
      const now = disk.has(path) ? disk.get(path) : await look(path);
      const known = view.get(path);
      if (!now) deferrals.delete(path);
      if (!known && !now) {
        pendingRemovals.delete(path);
        continue;
      }
      if (now?.kind === 'file' && (!known || !sameState(known, now))) {
        // Hint 3: still being written? Look again once it settles.
        const age = Date.now() - now.mtimeMs;
        const attempts = deferrals.get(path) || 0;
        if (age >= 0 && age < stabilityMs && attempts < 50) {
          deferrals.set(path, attempts + 1);
          retry.push(path);
          continue;
        }
        deferrals.delete(path);
      }
      if (!known) {
        changes.push(now.kind === 'dir' ? { op: 'mkdir', path, state: now } : { op: 'write', path, state: now, base: null });
        view.set(path, now);
        pendingRemovals.delete(path);
        continue;
      }
      if (!now) {
        removalCandidates.push(path);
        continue;
      }
      pendingRemovals.delete(path);
      if (known.kind !== now.kind) {
        // Replaced by another kind of entry: the peer must remove the old one
        // before it can create the new one, so both go out together, in order.
        changes.push(known.kind === 'dir' ? { op: 'rmdir', path } : { op: 'unlink', path, base: known });
        changes.push(now.kind === 'dir' ? { op: 'mkdir', path, state: now } : { op: 'write', path, state: now, base: null });
        view.deleteTree(path);
        view.set(path, now);
        continue;
      }
      if (now.kind === 'file' && !sameState(known, now)) {
        changes.push({ op: 'write', path, state: now, base: known });
        view.set(path, now);
        continue;
      }
      if (identityKey(known) !== identityKey(now)) {
        // Same content under a new inode (an editor's atomic save that wrote
        // identical bytes). Nothing to send, but future rename detection needs
        // the new inode.
        changes.push({ op: 'reindex', path, state: now });
        view.set(path, now);
      }
    }

    // --- Phase C: removals, held back while a rename could still complete ----
    // Group every removed path under its top-most removed ancestor, in one
    // pass (a deleted tree can hold tens of thousands of entries).
    const removalSet = new Set(removalCandidates);
    /** @type {Map<string, string[]>} top-most removed path -> everything removed below it */
    const groups = new Map();
    for (const path of removalCandidates) {
      let top = path;
      for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
        if (removalSet.has(path.slice(0, cut))) top = path.slice(0, cut);
      }
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top).push(path);
    }
    /** @type {SyncOp[]} */
    const removals = [];
    nextRemovalDue = 0;
    for (const [top, group] of groups) {
      for (const path of group) if (!pendingRemovals.has(path)) pendingRemovals.set(path, startedAt);
      let newest = 0;
      for (const path of group) newest = Math.max(newest, pendingRemovals.get(path));
      const due = newest + renameWindowMs;
      if (Date.now() < due) {
        nextRemovalDue = nextRemovalDue ? Math.min(nextRemovalDue, due) : due;
        continue;
      }
      for (const path of group) pendingRemovals.delete(path);
      const known = view.get(top);
      removals.push(known.kind === 'dir' ? { op: 'rmdir', path: top } : { op: 'unlink', path: top, base: known });
    }
    // Forget pending removals that are no longer candidates for any reason.
    for (const path of [...pendingRemovals.keys()]) if (!removalSet.has(path)) pendingRemovals.delete(path);
    removals.sort((a, b) => depthOf(b.path) - depthOf(a.path));

    if (retry.length > 0) {
      for (const path of retry) touched.add(path);
      nextRetryDue = Date.now() + Math.max(20, Math.floor(stabilityMs / 2));
    }

    const ops = [...renames, ...changes, ...removals];
    logger?.debug?.(
      `batch: ${candidates.size} path(s) examined in ${Date.now() - startedAt} ms, ${ops.length} operation(s)` +
        (pendingRemovals.size ? `, ${pendingRemovals.size} removal(s) held back` : '') +
        (retry.length ? `, ${retry.length} file(s) still changing` : ''),
      ops.map((op) => (op.op === 'rename' ? `rename ${op.from} -> ${op.to}` : `${op.op} ${op.path}`)),
    );
    if (ops.length > 0 && !closed) await onOps(ops);
  }

  return {
    /** Resolves once chokidar has finished its initial scan. */
    ready,
    /** Force a path to be re-examined in the next batch. */
    touch,
    /** Compare the whole tree with the index now; returns the number of differences. */
    rescan,
    /** Process whatever is pending right now; resolves when that batch is done. */
    flush() {
      clearTimeout(timer);
      return fire();
    },
    /** Paths waiting to be examined, plus removals being held back. */
    get pending() {
      return touched.size + pendingRemovals.size;
    },
    /** Stop watching. Safe to call twice. */
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearInterval(rescanTimer);
      touched.clear();
      pendingRemovals.clear();
      await watcher.close();
    },
  };
}
