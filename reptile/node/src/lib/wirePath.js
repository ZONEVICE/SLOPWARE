/**
 * Wire paths: how a file inside a synced directory is named between instances.
 *
 * A wire path is relative to the synced root, uses "/" as the separator on
 * every platform, and has no leading or trailing slash. The root itself is the
 * empty string "". Examples: "notes.txt", "photos/2024/beach.jpg".
 *
 * Every path that arrives from the network goes through `normalizeWirePath`
 * before it touches the disk, and `resolveWirePath` re-checks containment
 * after joining. Together they make "../../etc/passwd" impossible to express.
 */
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const WINDOWS = process.platform === 'win32';

/**
 * Validate and canonicalise a wire path.
 *
 * @param {unknown} input
 * @param {{ allowRoot?: boolean }} [options] Whether "" (the root) is acceptable.
 * @returns {string|null} The canonical path, or null when it is not acceptable.
 */
export function normalizeWirePath(input, options = {}) {
  if (typeof input !== 'string') return null;
  if (input.includes('\0')) return null;
  // Tolerate one leading/trailing slash from sloppy callers, nothing more.
  const trimmed = input.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return options.allowRoot ? '' : null;

  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    // Windows cannot store these; refusing them keeps the tree portable to a
    // Windows peer instead of failing halfway through a sync.
    if (WINDOWS && /[\\:*?"<>|]/.test(segment)) return null;
  }
  return segments.join('/');
}

/**
 * Convert a native relative path (from `path.relative`) to a wire path.
 * @param {string} nativeRelative
 */
export function toWirePath(nativeRelative) {
  return sep === '/' ? nativeRelative : nativeRelative.split(sep).join('/');
}

/**
 * Wire path of an absolute path inside `root`, or null when it is outside.
 * @param {string} root Absolute root directory.
 * @param {string} absolute
 */
export function wirePathOf(root, absolute) {
  const rel = relative(root, absolute);
  if (rel === '') return '';
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return toWirePath(rel);
}

/**
 * Join a wire path onto a root and verify the result stays inside it.
 *
 * This is a lexical check. Symlinks inside the tree are handled separately by
 * `src/fs/mutate.js`, which refuses to write through them.
 *
 * @param {string} root Absolute root directory.
 * @param {string} wirePath Already normalised.
 * @returns {string} Absolute path.
 */
export function resolveWirePath(root, wirePath) {
  const base = resolve(root);
  if (wirePath === '') return base;
  const full = resolve(base, join(...wirePath.split('/')));
  if (full !== base && !full.startsWith(base.endsWith(sep) ? base : base + sep)) {
    const error = new Error(`Path escapes the synced directory: ${wirePath}`);
    error.code = 'EPATHESCAPE';
    throw error;
  }
  return full;
}

/** Parent of a wire path; the parent of a top-level entry is "". */
export function parentOf(wirePath) {
  const index = wirePath.lastIndexOf('/');
  return index === -1 ? '' : wirePath.slice(0, index);
}

/** Last segment of a wire path. */
export function baseName(wirePath) {
  const index = wirePath.lastIndexOf('/');
  return index === -1 ? wirePath : wirePath.slice(index + 1);
}

/** Number of segments; the root has depth 0. */
export function depthOf(wirePath) {
  return wirePath === '' ? 0 : wirePath.split('/').length;
}

/** Join two wire paths. */
export function joinWire(parent, child) {
  if (!parent) return child;
  if (!child) return parent;
  return `${parent}/${child}`;
}

/**
 * True when `child` is `parent` itself or lies below it.
 * @param {string} parent
 * @param {string} child
 */
export function isSameOrInside(parent, child) {
  if (parent === '') return true;
  return child === parent || child.startsWith(`${parent}/`);
}

/** True when `child` lies strictly below `parent`. */
export function isStrictlyInside(parent, child) {
  if (parent === '') return child !== '';
  return child.startsWith(`${parent}/`);
}

/**
 * Replace the `from` prefix of `path` with `to`.
 * `rebase("a/b/c", "a/b", "x")` is "x/c".
 */
export function rebase(path, from, to) {
  if (path === from) return to;
  return joinWire(to, path.slice(from.length + 1));
}

/**
 * Every proper ancestor of a wire path, nearest first, excluding the root.
 * `ancestorsOf("a/b/c")` is ["a/b", "a"].
 */
export function ancestorsOf(wirePath) {
  const out = [];
  let current = parentOf(wirePath);
  while (current !== '') {
    out.push(current);
    current = parentOf(current);
  }
  return out;
}

/**
 * Order paths so that every parent precedes its children and siblings stay
 * together: compare segment by segment instead of as flat strings (a flat
 * comparison puts "a-b" between "a" and "a/b").
 * @param {string} a
 * @param {string} b
 */
export function compareWirePaths(a, b) {
  const left = a.split('/');
  const right = b.split('/');
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.length - right.length;
}

/**
 * Sort wire paths with the same order as `compareWirePaths`, but fast: each
 * path is turned once into a key where "/" becomes "\u0000", which sorts
 * before every other character, so plain string comparison keeps parents
 * before children and siblings together. Batches and plans sort tens of
 * thousands of paths; splitting both strings on every comparison was the
 * single most expensive step.
 * @param {Iterable<string>} paths
 * @returns {string[]}
 */
export function sortWirePaths(paths) {
  return [...paths]
    .map((path) => [path.replaceAll('/', '\u0000'), path])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((pair) => pair[1]);
}
