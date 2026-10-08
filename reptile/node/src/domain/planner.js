/**
 * Three-way reconciliation planner.
 *
 * Pure function, no I/O. Given three snapshots of the synced tree:
 *
 *   local   what is on this machine's disk now,
 *   remote  what the host shares now (its manifest),
 *   base    what both sides had the last time they were known to agree,
 *
 * it decides, path by path, which side's version survives. The base is what
 * makes a deletion distinguishable from a creation: a file present locally,
 * absent remotely and present in the base was deleted remotely; the same file
 * absent from the base was created locally. Without a base (the very first
 * connection) nothing is ever deleted: the two trees are merged.
 *
 * Rules, in order:
 *   1. Both sides equal                   -> nothing to do (record the base).
 *   2. Only one side changed since base   -> that side wins.
 *   3. Both changed (or no base):
 *        one side absent                  -> the present side wins
 *                                            (a modification beats a deletion)
 *        both files                       -> the newer mtime wins; on a tie, the host
 *        file on one side, dir on other   -> conflict: left alone and reported
 *
 * The same planner runs for the initial synchronisation, after every
 * reconnection, and whenever the live path hits something it cannot apply
 * safely, which is what makes the engine self-healing.
 */
import { sameState } from '../fs/entry.js';
import { isStrictlyInside, parentOf, sortWirePaths } from '../lib/wirePath.js';

/**
 * @typedef {{ kind: 'file'|'dir', size: number, mtimeMs: number }} State
 * @typedef {'in-sync'|'adopt-mtime'|'forget'|'download'|'local-mkdir'|'local-delete'|'upload'|'remote-mkdir'|'remote-delete'} ActionType
 * @typedef {{ type: ActionType, path: string, local: State|null, remote: State|null, base: State|null }} Action
 */

/** Which side wins when both changed. */
function resolveBoth(local, remote) {
  if (!local) return 'remote';
  if (!remote) return 'local';
  if (local.kind !== remote.kind) return 'conflict';
  if (local.kind === 'dir') return 'equal';
  return local.mtimeMs > remote.mtimeMs ? 'local' : 'remote';
}

/** The action that makes the losing side look like the winning side. */
function actionFor(winner, local, remote) {
  if (winner === 'remote') {
    if (!remote) return 'local-delete';
    return remote.kind === 'dir' ? 'local-mkdir' : 'download';
  }
  if (!local) return 'remote-delete';
  return local.kind === 'dir' ? 'remote-mkdir' : 'upload';
}

/** Kind that will exist on each side once an action has been carried out. */
function finalKinds(type, local, remote) {
  const l = local?.kind ?? null;
  const r = remote?.kind ?? null;
  switch (type) {
    case 'in-sync':
    case 'adopt-mtime':
      return { local: l, remote: r };
    case 'forget':
      return { local: null, remote: null };
    case 'download':
      return { local: 'file', remote: r };
    case 'local-mkdir':
      return { local: 'dir', remote: r };
    case 'local-delete':
      return { local: null, remote: r };
    case 'upload':
      return { local: l, remote: 'file' };
    case 'remote-mkdir':
      return { local: l, remote: 'dir' };
    case 'remote-delete':
      return { local: l, remote: null };
    default:
      return { local: l, remote: r };
  }
}

/**
 * Plan a reconciliation.
 *
 * @param {object} input
 * @param {Map<string, State>} input.local
 * @param {Map<string, State>} input.remote
 * @param {Map<string, State>} input.base
 * @param {(path: string) => boolean} [input.isRejected] Paths the host refuses to accept.
 * @param {Set<string>} [input.equalContent] Files known (by hash) to have identical content on both sides.
 * @returns {{ actions: Action[], conflicts: { path: string, local: State|null, remote: State|null }[] }}
 */
export function planSync({ local, remote, base, isRejected = () => false, equalContent = new Set() }) {
  const all = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
  all.delete('');
  const sorted = sortWirePaths(all);

  /** @type {Map<string, { type: ActionType|'none'|'conflict', local: State|null, remote: State|null, base: State|null }>} */
  const decisions = new Map();
  const blocked = [];

  for (const path of sorted) {
    const l = local.get(path) ?? null;
    const r = remote.get(path) ?? null;
    const b = base.get(path) ?? null;
    const entry = { type: 'none', local: l, remote: r, base: b };
    decisions.set(path, entry);

    if (blocked.some((prefix) => isStrictlyInside(prefix, path))) continue;

    if (sameState(l, r)) {
      entry.type = l ? 'in-sync' : b ? 'forget' : 'none';
      continue;
    }
    if (l && r && l.kind === 'file' && r.kind === 'file' && l.size === r.size && equalContent.has(path)) {
      // Same bytes, different mtime: align the local mtime instead of copying.
      entry.type = 'adopt-mtime';
      continue;
    }

    let winner;
    if (b) {
      const localChanged = !sameState(l, b);
      const remoteChanged = !sameState(r, b);
      if (!localChanged) winner = 'remote';
      else if (!remoteChanged) winner = 'local';
      else winner = resolveBoth(l, r);
    } else {
      winner = resolveBoth(l, r);
    }

    if (winner === 'equal') {
      entry.type = 'in-sync';
      continue;
    }
    if (winner === 'conflict') {
      entry.type = 'conflict';
      blocked.push(path);
      continue;
    }
    if (winner === 'local' && !r && isRejected(path)) continue;
    entry.type = actionFor(winner, l, r);
  }

  // --- Directory consistency --------------------------------------------------
  // Children are decided independently of their parents. Afterwards, a
  // directory about to be deleted on one side while one of its children must
  // stay there is kept (and recreated on the other side instead); and a
  // directory about to be replaced by a file while children must stay becomes
  // a conflict.
  const reconcileDirectories = () => {
    const localChildren = new Set();
    const remoteChildren = new Set();
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const path = sorted[index];
      const entry = decisions.get(path);
      const hasLocalChild = localChildren.has(path);
      const hasRemoteChild = remoteChildren.has(path);

      if (entry.type === 'local-delete' && entry.local?.kind === 'dir' && hasLocalChild) {
        entry.type = entry.remote ? 'in-sync' : 'remote-mkdir';
      } else if (entry.type === 'remote-delete' && entry.remote?.kind === 'dir' && hasRemoteChild) {
        entry.type = entry.local ? 'in-sync' : 'local-mkdir';
      } else if (entry.type === 'download' && entry.local?.kind === 'dir' && hasLocalChild) {
        entry.type = 'conflict';
      } else if (entry.type === 'upload' && entry.remote?.kind === 'dir' && hasRemoteChild) {
        entry.type = 'conflict';
      }

      const kinds = finalKinds(entry.type, entry.local, entry.remote);
      const parent = parentOf(path);
      if (parent !== '') {
        if (kinds.local) localChildren.add(parent);
        if (kinds.remote) remoteChildren.add(parent);
      }
    }
  };
  reconcileDirectories();

  // A conflict freezes everything below it.
  const conflictPaths = sorted.filter((path) => decisions.get(path).type === 'conflict');
  if (conflictPaths.length > 0) {
    for (const path of sorted) {
      if (conflictPaths.some((prefix) => isStrictlyInside(prefix, path))) decisions.get(path).type = 'none';
    }
    reconcileDirectories();
  }

  const actions = [];
  const conflicts = [];
  for (const path of sorted) {
    const entry = decisions.get(path);
    if (entry.type === 'none') continue;
    if (entry.type === 'conflict') {
      conflicts.push({ path, local: entry.local, remote: entry.remote });
      continue;
    }
    actions.push({ type: entry.type, path, local: entry.local, remote: entry.remote, base: entry.base });
  }
  return { actions, conflicts };
}

/**
 * Files whose content equality would change the plan: same size on both sides,
 * different mtime, and no base that already explains the difference. Hash
 * these before planning.
 * @param {{ local: Map<string, State>, remote: Map<string, State>, base: Map<string, State> }} input
 * @returns {string[]}
 */
export function hashCandidates({ local, remote, base }) {
  const out = [];
  for (const [path, l] of local) {
    const r = remote.get(path);
    if (!r || l.kind !== 'file' || r.kind !== 'file') continue;
    if (l.size !== r.size || l.mtimeMs === r.mtimeMs) continue;
    const b = base.get(path);
    // With a base and exactly one side changed, the plan is already clear.
    if (b && (sameState(l, b) || sameState(r, b))) continue;
    out.push(path);
  }
  return out;
}

/** Execution order: deletions (deepest first), then directories (shallowest first), then transfers. */
export const ACTION_PHASES = Object.freeze([
  ['in-sync', 'adopt-mtime', 'forget'],
  ['local-delete', 'remote-delete'],
  ['local-mkdir', 'remote-mkdir'],
  ['download', 'upload'],
]);
