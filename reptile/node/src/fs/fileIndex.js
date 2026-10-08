/**
 * An in-memory map of wire path -> entry state, with an inode lookup and a
 * parent -> children map.
 *
 * Both sides keep one, with slightly different meanings:
 *  - the host's index is the state it last observed and announced;
 *  - the syncing side's index is the state it last knew to be identical on
 *    both machines (the "base" of the three-way comparison in planner.js).
 *
 * In both cases the watcher diffs the disk against it to find changes, and the
 * identity lookup lets it recognise renames. The children map keeps subtree
 * operations (a deleted or renamed directory) proportional to the subtree:
 * scanning every entry per directory made deleting a tree of 15 000 entries
 * take seconds.
 */
import { identityKey, publicState } from './entry.js';
import { parentOf, rebase } from '../lib/wirePath.js';

export class FileIndex {
  constructor() {
    /** @type {Map<string, import('./entry.js').EntryState>} */
    this.entries = new Map();
    /** @type {Map<string, string>} identity key -> wire path */
    this.identities = new Map();
    /** @type {Map<string, Set<string>>} parent wire path -> child wire paths */
    this.children = new Map();
  }

  /** Number of entries. */
  get size() {
    return this.entries.size;
  }

  /** @param {string} path */
  get(path) {
    return this.entries.get(path) ?? null;
  }

  /** @param {string} path */
  has(path) {
    return this.entries.has(path);
  }

  /**
   * Record the state of a path.
   * @param {string} path
   * @param {import('./entry.js').EntryState} state
   */
  set(path, state) {
    const previous = this.entries.get(path);
    if (previous) this.#forgetIdentity(path, previous);
    const stored = {
      kind: state.kind,
      size: state.kind === 'file' ? state.size : 0,
      mtimeMs: state.mtimeMs,
      ino: state.ino,
      dev: state.dev,
    };
    this.entries.set(path, stored);
    if (!previous) this.#link(path);
    const key = identityKey(stored);
    if (key) this.identities.set(key, path);
  }

  /** Forget one path (not its descendants). */
  delete(path) {
    const previous = this.entries.get(path);
    if (!previous) return;
    this.#forgetIdentity(path, previous);
    this.entries.delete(path);
    this.#unlink(path);
  }

  /** Forget a path and everything below it. */
  deleteTree(path) {
    for (const [child] of [...this.descendants(path)]) this.delete(child);
    this.delete(path);
  }

  /**
   * Entries strictly below `path`, parents before children.
   * @param {string} path
   * @returns {Generator<[string, import('./entry.js').EntryState]>}
   */
  *descendants(path) {
    const stack = [...(this.children.get(path) || [])].reverse();
    while (stack.length > 0) {
      const child = stack.pop();
      const state = this.entries.get(child);
      if (state) yield [child, state];
      const below = this.children.get(child);
      if (below) for (const grandchild of [...below].reverse()) stack.push(grandchild);
    }
  }

  /**
   * Which path currently holds this identity, if any.
   * @param {string|null} key From `identityKey()`.
   */
  pathForIdentity(key) {
    if (!key) return null;
    const path = this.identities.get(key);
    if (!path) return null;
    // Guard against a stale mapping left behind by an overwrite.
    return identityKey(this.entries.get(path)) === key ? path : null;
  }

  /**
   * Move a path and all of its descendants to a new location, keeping their
   * states (a rename keeps sizes, mtimes and inodes).
   * @param {string} from
   * @param {string} to
   */
  rekey(from, to) {
    if (from === to) return;
    const moving = [];
    const own = this.entries.get(from);
    if (own) moving.push([from, own]);
    for (const entry of this.descendants(from)) moving.push(entry);
    for (const [path] of moving) this.delete(path);
    // Whatever was at the destination is replaced, as rename(2) would do.
    this.deleteTree(to);
    for (const [path, state] of moving) this.set(rebase(path, from, to), state);
  }

  /** Remove everything. */
  clear() {
    this.entries.clear();
    this.identities.clear();
    this.children.clear();
  }

  /**
   * Replace the whole content.
   * @param {Map<string, import('./entry.js').EntryState>} map
   */
  replaceAll(map) {
    this.clear();
    for (const [path, state] of map) this.set(path, state);
  }

  /**
   * Plain snapshot with only peer-relevant fields.
   * @returns {Map<string, { kind: string, size: number, mtimeMs: number }>}
   */
  toPublicMap() {
    const out = new Map();
    for (const [path, state] of this.entries) out.set(path, publicState(state));
    return out;
  }

  /**
   * Link a path under its parent, and the parent under its own parent, up to
   * the root. Ancestors that are not entries themselves become "virtual"
   * nodes, so an entry whose directory was never indexed is still reachable
   * from every ancestor.
   */
  #link(path) {
    let child = path;
    while (child !== '') {
      const parent = parentOf(child);
      let set = this.children.get(parent);
      if (!set) {
        set = new Set();
        this.children.set(parent, set);
      }
      if (set.has(child)) return; // the rest of the chain is already linked
      set.add(child);
      child = parent;
    }
  }

  /** Unlink a path that is no entry and has no children, then its empty virtual ancestors. */
  #unlink(path) {
    let child = path;
    while (child !== '') {
      if (this.entries.has(child) || this.children.has(child)) return;
      const parent = parentOf(child);
      const set = this.children.get(parent);
      if (!set) return;
      set.delete(child);
      if (set.size === 0) this.children.delete(parent);
      child = parent;
    }
  }

  #forgetIdentity(path, state) {
    const key = identityKey(state);
    if (key && this.identities.get(key) === path) this.identities.delete(key);
  }
}

/**
 * Apply a completed operation to an index.
 *
 * Used by the host right after it announces a change, and by the syncing side
 * once the host confirms it applied one. Keeping this in one place is what
 * keeps the two sides' bookkeeping identical.
 *
 * @param {FileIndex} index
 * @param {{ op: string, path?: string, from?: string, to?: string, state?: object }} op
 */
export function commitOp(index, op) {
  switch (op.op) {
    case 'rename':
      index.rekey(op.from, op.to);
      if (op.state) index.set(op.to, op.state);
      break;
    case 'mkdir':
    case 'write':
    case 'reindex':
      if (op.state) index.set(op.path, op.state);
      break;
    case 'unlink':
      index.delete(op.path);
      break;
    case 'rmdir':
      index.deleteTree(op.path);
      break;
    default:
      break;
  }
}
