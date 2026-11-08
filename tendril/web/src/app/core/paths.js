/**
 * Workspace-relative path helpers. Paths always use "/" and never start with
 * one; "" is the workspace root.
 */

export function join(...parts) {
  return parts
    .flatMap((p) => String(p || '').split('/'))
    .filter((p) => p && p !== '.')
    .join('/');
}

export function dirname(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function basename(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** Lower-case extension without the dot ("" when none; dotfiles have none). */
export function extname(path) {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * Resolves `target` against the folder `base`, like a link in a document:
 * relative to `base`, or to the workspace root when it starts with "/".
 * Null when it would climb above the workspace root.
 */
export function resolve(base, target) {
  const parts = target.startsWith('/') ? [] : base.split('/').filter(Boolean);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** True when `path` is `parent` or inside it. */
export function isWithin(parent, path) {
  return parent === '' || path === parent || path.startsWith(`${parent}/`);
}

/** Replaces the `from` prefix of `path` with `to` (after a move). */
export function rebase(path, from, to) {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return join(to, path.slice(from.length + 1));
  return path;
}

/** Natural, case-insensitive comparison ("file2" < "file10"). */
export const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
