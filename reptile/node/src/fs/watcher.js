/**
 * Filesystem watcher and change detector.
 *
 * The operating system reports that something happened to a path
 * (`src/fs/dirWatch.js`, on top of `fs.watch`). Those notifications cannot be
 * forwarded to a peer as they are:
 *
 *  - there is no portable rename event. Renaming "a" to "b" arrives as two
 *    unrelated notifications, in either order, sometimes in different
 *    directories. Forwarding them literally would delete the file on the peer
 *    and upload it again.
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
 * Nothing here trusts a single notification to arrive. Four hints together
 * make detection complete:
 *   1. every fs.watch notification touches the path it names (or, when the
 *      platform gives no name, every entry of the directory it came from);
 *   2. a new or renamed directory, and any directory that just got its own
 *      watcher, is walked, so files created inside it before the watcher
 *      existed are examined too;
 *   3. a file modified in the last `stabilityMs` is re-examined later rather
 *      than sent half-written;
 *   4. every `rescanIntervalMs` the whole tree is compared with the index
 *      (an inotify queue overflow under a flood of changes, the watch limit).
 */
import { lstat, readdir } from 'node:fs/promises';
import { createWatchTree } from './dirWatch.js';
import { identityKey, isSyncable, isTempName, readState, sameState, stateFromStats } from './entry.js';
import { depthOf, isStrictlyInside, joinWire, rebase, resolveWirePath, sortWirePaths } from '../lib/wirePath.js';

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
 * @param {(wirePath: string) => boolean} [options.ignore]
 *   Paths that must never be reported.
 * @param {(dirWire: string) => boolean} [options.ignoreInside]
 *   Directories whose content must not even be watched (the inside of an
 *   unshared directory). Defaults to `ignore`.
 * @param {(wirePath: string, state: object) => void} [options.onRawAdd]
 *   Called for every path found on disk where the index does not have it
 *   (or has another inode), as soon as the batch looks at it and before
 *   anything inside it is examined.
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
 * @param {boolean} [options.recursive] One recursive OS watcher instead of one
 *   per directory; defaults to what the platform supports natively.
 * @param {object} [options.logger]
 */
export function createDirectoryWatcher(options) {
  const {
    root,
    index,
    onOps,
    ignore = () => false,
    ignoreInside = ignore,
    onRawAdd,
    run = (fn) => fn(),
    onRootMissing,
    onError,
    quietMs = 150,
    maxWaitMs = 1000,
    renameWindowMs = 1200,
    stabilityMs = 300,
    rescanIntervalMs = 5 * 60_000,
    recursive,
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

  const visible = (wire) => wire !== null && wire !== '' && !ignore(wire);

  /** Hint 1, for platforms that do not say which entry changed. */
  async function touchChildren(dirWire) {
    if (closed) return;
    if (dirWire !== '' && visible(dirWire)) touch(dirWire);
    // What the index holds there, for deletions, plus what the disk holds.
    for (const child of index.children.get(dirWire) || []) if (visible(child)) touch(child);
    let names = [];
    try {
      names = await readdir(resolveWirePath(root, dirWire));
    } catch {
      // The root itself may be what went away; never wait for a batch to
      // notice when the index is empty and nothing else would be touched.
      if (dirWire === '') {
        const rootState = await readState(root).catch(() => null);
        if (!closed && rootState?.kind !== 'dir') onRootMissing?.();
      }
      return;
    }
    for (const name of names) {
      const child = joinWire(dirWire, name);
      if (!isTempName(name) && visible(child)) touch(child);
    }
  }

  const tree = createWatchTree({
    root,
    recursive,
    watchable: (dirWire) => !ignoreInside(dirWire),
    onHint: (wire) => {
      if (!closed && visible(wire)) touch(wire);
    },
    onDirectory: (dirWire) => {
      touchChildren(dirWire).catch((error) => logger?.debug?.('directory hint failed:', error.message));
    },
    onError: (error) => {
      logger?.warn?.('watcher error:', error?.message || error);
      onError?.(error);
    },
  });

  const ready = tree.start();

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
    // Paths put back for a retry carry no touch time: they wait for
    // `nextRetryDue` instead of firing again at once (which spun the batch
    // loop up to 50 times while a file was still young).
    if (touched.size > 0 && firstTouchAt) due = Math.min(lastTouchAt + quietMs, firstTouchAt + maxWaitMs);
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
    const directories = new Set();
    let differences = 0;
    const stack = [''];
    while (stack.length > 0) {
      const directory = stack.pop();
      // Repair the watcher set as well: a directory whose watcher could not be
      // created (the watch limit) gets another chance, and its content is
      // compared right below anyway.
      tree.add(directory);
      directories.add(directory);
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
    if (!closed) tree.retain(directories);
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
      if (state && onRawAdd) {
        const known = index.get(path);
        if (!known || identityKey(known) !== identityKey(state)) {
          try {
            onRawAdd(path, state);
          } catch (error) {
            logger?.error?.('onRawAdd failed:', error);
          }
        }
      }
      return state;
    };
    await forEachLimit([...candidates], 64, look);

    /** Hint 2: add everything below a directory as candidates. */
    const expanded = new Set();
    const expand = async (directory) => {
      if (expanded.has(directory)) return;
      expanded.add(directory);
      const stack = [directory];
      while (stack.length > 0) {
        const current = stack.pop();
        // Watch first, list second: nothing created in between is missed.
        tree.add(current);
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
    // descendants with it, whether or not each of them was reported.
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

    // A directory that just got its own watcher may already hold entries
    // created before the watcher existed: look inside it (hint 2). This also
    // covers directories the owner created itself and recorded in the index
    // first, which therefore never show up as new below.
    for (const path of [...candidates]) {
      if (disk.get(path)?.kind === 'dir' && !tree.has(path) && tree.add(path)) {
        expanded.delete(path);
        await expand(path);
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

    // Directories that vanished or moved away release their watchers; a moved
    // directory was given new ones at its new location above.
    if (!tree.recursive) {
      const gone = [];
      for (const path of candidates) if (tree.has(path) && disk.get(path)?.kind !== 'dir') gone.push(path);
      tree.remove(gone);
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
    /** Resolves once every directory is watched. */
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
    /** How many OS watchers are open (one per directory, or 1 when recursive). */
    get watching() {
      return tree.size;
    },
    /** True when one recursive OS watcher covers the whole tree. */
    recursive: tree.recursive,
    /** Stop watching. Safe to call twice. */
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearInterval(rescanTimer);
      touched.clear();
      pendingRemovals.clear();
      tree.close();
    },
  };
}
