/**
 * Directory traversal.
 *
 * Two shapes of the same walk:
 *  - `walkTree` returns a flat Map of wire path -> state. It seeds the host's
 *    index, builds the manifest a syncing peer downloads, and lists the local
 *    side before a reconciliation.
 *  - `buildTree` returns the nested structure the interface renders as the
 *    checkbox tree of the "Host a directory" screen.
 *
 * Symlinks are never followed. Reptile's own temporary files are always left
 * out, so a half-received file is never listed or re-sent.
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isTempName, stateFromStats } from './entry.js';
import { joinWire, sortWirePaths } from '../lib/wirePath.js';

/**
 * @callback WalkFilter
 * @param {string} wirePath
 * @param {import('./entry.js').EntryState|{ kind: 'other' }} state
 * @returns {'include'|'prune'|'skip'} `prune` leaves out the entry and, for a
 *   directory, everything below it. `skip` leaves out only the entry itself.
 */

/**
 * Walk a directory tree.
 *
 * @param {string} root Absolute path of the tree.
 * @param {object} [options]
 * @param {WalkFilter} [options.filter]
 * @param {boolean} [options.includeOther] Include symlinks and special files as `{ kind: 'other' }`.
 * @param {(error: Error, wirePath: string) => void} [options.onError] Unreadable subdirectories.
 * @param {number} [options.limit] Stop after this many entries.
 * @returns {Promise<{ entries: Map<string, object>, truncated: boolean }>}
 */
export async function walkTree(root, options = {}) {
  const { filter, includeOther = false, onError, limit = Infinity } = options;
  const entries = new Map();
  const stack = [''];
  let truncated = false;

  while (stack.length > 0) {
    const dirWire = stack.pop();
    const dirAbs = dirWire === '' ? root : join(root, ...dirWire.split('/'));
    let names;
    try {
      names = await readdir(dirAbs);
    } catch (error) {
      if (dirWire === '') throw error;
      onError?.(error, dirWire);
      continue;
    }

    const states = await Promise.all(
      names.map(async (name) => {
        if (isTempName(name)) return null;
        try {
          return { name, state: stateFromStats(await lstat(join(dirAbs, name))) };
        } catch (error) {
          // Vanished between readdir and lstat: simply not there any more.
          if (error.code !== 'ENOENT') onError?.(error, joinWire(dirWire, name));
          return null;
        }
      }),
    );

    for (const item of states) {
      if (!item) continue;
      const wire = joinWire(dirWire, item.name);
      if (item.state.kind === 'other' && !includeOther) continue;
      const decision = filter ? filter(wire, item.state) : 'include';
      if (decision === 'prune') continue;
      if (decision !== 'skip') {
        if (entries.size >= limit) {
          truncated = true;
          return { entries, truncated };
        }
        entries.set(wire, item.state);
      }
      if (item.state.kind === 'dir') stack.push(wire);
    }
  }

  return { entries, truncated };
}

/**
 * Build the nested tree shown in the content-selection step.
 *
 * Every node carries its wire path so that the browser can send exclusions
 * back verbatim. Directories come first, then files, each group sorted
 * naturally ("file2" before "file10"). Links and special files are listed but
 * flagged as not synchronisable, so the user is not surprised later.
 *
 * @param {string} root
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ tree: object, total: number, truncated: boolean }>}
 */
export async function buildTree(root, options = {}) {
  const errors = new Map();
  const { entries, truncated } = await walkTree(root, {
    includeOther: true,
    limit: options.limit ?? 250_000,
    onError: (error, wire) => errors.set(wire, error.code === 'EACCES' || error.code === 'EPERM' ? 'Permission denied' : error.message),
  });

  const rootNode = { name: '', path: '', kind: 'dir', children: [] };
  const nodes = new Map([['', rootNode]]);
  const paths = sortWirePaths(entries.keys());

  for (const path of paths) {
    const state = entries.get(path);
    const slash = path.lastIndexOf('/');
    const parentPath = slash === -1 ? '' : path.slice(0, slash);
    const parent = nodes.get(parentPath);
    if (!parent) continue; // parent skipped (limit reached mid-directory)
    const node = {
      name: slash === -1 ? path : path.slice(slash + 1),
      path,
      kind: state.kind === 'other' ? 'other' : state.kind,
    };
    if (state.kind === 'file') node.size = state.size;
    if (state.kind === 'dir') {
      node.children = [];
      if (errors.has(path)) node.error = errors.get(path);
    }
    parent.children.push(node);
    nodes.set(path, node);
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const sortChildren = (node) => {
    if (!node.children) return;
    node.children.sort((a, b) => {
      const rank = (n) => (n.kind === 'dir' ? 0 : 1);
      return rank(a) - rank(b) || collator.compare(a.name, b.name);
    });
    for (const child of node.children) sortChildren(child);
  };
  sortChildren(rootNode);

  return { tree: rootNode, total: entries.size, truncated };
}
