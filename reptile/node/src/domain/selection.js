/**
 * Content selection on the host: which paths are shared.
 *
 * The model is a set of EXCLUDED wire paths, the items the user unchecked in
 * the tree. A path is shared unless it or one of its ancestors is excluded.
 * That gives the behaviour the specification describes ("everything is checked
 * by default", "unchecking a directory unchecks all its content") and a
 * sensible answer for files created after hosting started: they are shared
 * unless they land inside an unchecked directory.
 *
 * "Unchecked items never leave the host and are never modified from the other
 * side" is enforced in two places:
 *   - outgoing: the manifest, the file endpoint and the live change feed all
 *     filter through `isExcluded`;
 *   - incoming: every operation a peer sends is refused with `not_shared` when
 *     it touches an excluded path.
 *
 * And one subtlety: an unchecked item stays unchecked when the host renames or
 * moves it. Exclusions are recorded by path AND by identity (device + inode),
 * so "secret.txt" renamed to "old-secret.txt" does not suddenly become shared.
 * Anything moved OUT of an unchecked directory, on the other hand, follows its
 * new location, which is what moving a file somewhere shared usually means.
 */
import { errors } from './errors.js';
import { isSameOrInside, isStrictlyInside, normalizeWirePath, parentOf, rebase } from '../lib/wirePath.js';

/**
 * Validate and simplify a list of excluded paths coming from the interface.
 *
 * Entries below another excluded entry are redundant and dropped. The root
 * itself cannot be excluded: that would share nothing at all.
 * @param {unknown} list
 * @returns {string[]}
 */
export function normalizeExclusions(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw errors.badRequest('The excluded list must be an array of paths.', 'bad_selection');
  const paths = new Set();
  for (const item of list) {
    const path = normalizeWirePath(item, { allowRoot: true });
    if (path === null) throw errors.badRequest(`Invalid path in the selection: ${String(item)}`, 'bad_selection');
    if (path === '') throw errors.badRequest('Select at least one item to share.', 'empty_selection');
    paths.add(path);
  }
  const sorted = [...paths].sort();
  return sorted.filter((path) => !sorted.some((other) => other !== path && isStrictlyInside(other, path)));
}

export class Selection {
  /**
   * @param {string[]} [excluded] Already normalised paths.
   */
  constructor(excluded = []) {
    /** @type {Set<string>} */
    this.excluded = new Set(excluded);
    /** @type {Map<string, string>} identity key -> excluded path */
    this.identities = new Map();
  }

  /** Build from untrusted input. */
  static fromInput(list) {
    return new Selection(normalizeExclusions(list));
  }

  /** Number of explicit exclusions. */
  get size() {
    return this.excluded.size;
  }

  /** Explicit exclusions, sorted. */
  list() {
    return [...this.excluded].sort();
  }

  /** True when `path` itself was unchecked (not merely inside something unchecked). */
  isExplicit(path) {
    return this.excluded.has(path);
  }

  /** True when `path` is not shared. */
  isExcluded(path) {
    if (this.excluded.size === 0 || path === '') return false;
    for (let current = path; current !== ''; current = parentOf(current)) {
      if (this.excluded.has(current)) return true;
    }
    return false;
  }

  /** True when a proper ancestor of `path` is excluded. */
  hasExcludedAncestor(path) {
    if (this.excluded.size === 0 || path === '') return false;
    for (let current = parentOf(path); current !== ''; current = parentOf(current)) {
      if (this.excluded.has(current)) return true;
    }
    return false;
  }

  /** True when something strictly below `path` is excluded. */
  hasExclusionsInside(path) {
    for (const entry of this.excluded) if (isStrictlyInside(path, entry)) return true;
    return false;
  }

  /**
   * Remember the identity of an excluded item so it can be recognised after a
   * rename.
   * @param {string} path
   * @param {string|null} key From `identityKey()`.
   */
  bindIdentity(path, key) {
    if (key) this.identities.set(key, path);
  }

  /**
   * The excluded path an identity belongs to, if any.
   * @param {string|null} key
   */
  pathForIdentity(key) {
    return key ? this.identities.get(key) ?? null : null;
  }

  /**
   * An item with this identity appeared at `path`. If it is an unchecked item
   * that moved, keep it unchecked at its new location.
   * @param {string} path
   * @param {string|null} key
   * @returns {boolean} true when `path` became excluded because of this.
   */
  followIdentity(path, key) {
    const previous = this.pathForIdentity(key);
    if (previous === null || previous === path || this.excluded.has(path)) return false;
    this.excluded.add(path);
    this.identities.set(key, path);
    return true;
  }

  /**
   * The host renamed `from` to `to`. Exclusions at or below `from` follow it.
   *
   * Old entries are deliberately kept: if a new item is later created under
   * the old name, it stays unshared, which errs on the side of privacy.
   * @param {string} from
   * @param {string} to
   * @returns {boolean} true when the selection changed.
   */
  applyRename(from, to) {
    let changed = false;
    const inheritedExclusion = !this.excluded.has(from) && this.hasExcludedAncestor(from);
    for (const entry of [...this.excluded]) {
      if (isSameOrInside(from, entry)) {
        const moved = rebase(entry, from, to);
        if (!this.excluded.has(moved)) {
          this.excluded.add(moved);
          changed = true;
        }
      }
    }
    if (inheritedExclusion && !this.isExcluded(to)) {
      this.excluded.add(to);
      changed = true;
    }
    for (const [key, path] of [...this.identities]) {
      if (isSameOrInside(from, path)) this.identities.set(key, rebase(path, from, to));
    }
    return changed;
  }

  toJSON() {
    return { excluded: this.list() };
  }
}
