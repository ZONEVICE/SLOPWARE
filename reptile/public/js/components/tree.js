/**
 * The content-selection tree of the "Host a directory" screen.
 *
 * Model: a set of EXCLUDED paths, exactly what the server stores (see
 * src/domain/selection.js). Everything starts checked, i.e. the set is empty.
 * A node is:
 *   unchecked      when it or an ancestor is excluded,
 *   indeterminate  when it is not excluded but something below it is,
 *   checked        otherwise.
 *
 * Unchecking a node excludes it (and forgets exclusions below it: the node
 * covers them). Checking a node clears exclusions at and below it; if an
 * ancestor was excluded, that exclusion is split so that only this branch
 * comes back, and its siblings stay unchecked.
 *
 * Children are rendered the first time their directory is expanded, so a tree
 * with tens of thousands of entries stays responsive.
 */
import { h, icon } from '../core/dom.js';
import { formatBytes, plural } from '../core/format.js';

const parentOf = (path) => {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
};
const isSameOrInside = (parent, child) => parent === '' || child === parent || child.startsWith(`${parent}/`);
const isStrictlyInside = (parent, child) => (parent === '' ? child !== '' : child.startsWith(`${parent}/`));

/**
 * @param {{ onChange?: () => void }} [options]
 */
export function createTree({ onChange } = {}) {
  const box = h('div', { class: 'tree-box' });
  const summary = h('span', { class: 'hint', 'aria-live': 'polite' });
  /** @type {Map<string, object>} */
  const nodes = new Map();
  /** @type {Map<string, { row: HTMLElement, checkbox: HTMLInputElement|null, list: HTMLElement|null, twisty: HTMLElement|null }>} */
  const rendered = new Map();
  let excluded = new Set();
  let root = null;

  /** Precompute parents and subtree totals so counting never walks the tree. */
  const index = (node, parent) => {
    node.parent = parent;
    node.syncable = node.kind === 'file' || node.kind === 'dir';
    node.count = 0;
    node.bytes = node.kind === 'file' ? node.size || 0 : 0;
    nodes.set(node.path, node);
    for (const child of node.children || []) {
      index(child, node);
      if (child.syncable) {
        node.count += 1 + child.count;
        node.bytes += child.bytes;
      }
    }
  };

  const isExcluded = (path) => {
    for (let current = path; ; current = parentOf(current)) {
      if (excluded.has(current)) return true;
      if (current === '') return false;
    }
  };

  const hasExcludedBelow = (path) => {
    for (const entry of excluded) if (isStrictlyInside(path, entry)) return true;
    return false;
  };

  const stateOf = (path) => (isExcluded(path) ? 'unchecked' : hasExcludedBelow(path) ? 'mixed' : 'checked');

  const uncheck = (path) => {
    for (const entry of [...excluded]) if (isSameOrInside(path, entry)) excluded.delete(entry);
    excluded.add(path);
  };

  const check = (path) => {
    for (const entry of [...excluded]) if (isSameOrInside(path, entry)) excluded.delete(entry);
    // Find an excluded ancestor and split it along the way down to `path`.
    let ancestor = null;
    for (let current = parentOf(path); ; current = parentOf(current)) {
      if (excluded.has(current)) {
        ancestor = current;
        break;
      }
      if (current === '') break;
    }
    if (ancestor === null) return;
    excluded.delete(ancestor);
    let node = nodes.get(path);
    while (node && node.parent && node.path !== ancestor) {
      for (const sibling of node.parent.children || []) {
        if (sibling !== node && sibling.syncable) excluded.add(sibling.path);
      }
      node = node.parent;
    }
  };

  const refresh = () => {
    for (const [path, parts] of rendered) {
      if (!parts.checkbox) continue;
      const state = stateOf(path);
      parts.checkbox.checked = state === 'checked';
      parts.checkbox.indeterminate = state === 'mixed';
      parts.row.classList.toggle('excluded', state === 'unchecked');
    }
    summary.textContent = describe();
  };

  const totals = () => {
    if (!root) return { items: 0, bytes: 0, sharedItems: 0, sharedBytes: 0 };
    if (excluded.has('')) return { items: root.count, bytes: root.bytes, sharedItems: 0, sharedBytes: 0 };
    let items = root.count;
    let bytes = root.bytes;
    for (const path of excluded) {
      // Entries may point at nodes inside another excluded entry after a
      // split; only count the top-most ones.
      if ([...excluded].some((other) => other !== path && isStrictlyInside(other, path))) continue;
      const node = nodes.get(path);
      if (!node || !node.syncable) continue;
      items -= 1 + node.count;
      bytes -= node.bytes;
    }
    return { items: root.count, bytes: root.bytes, sharedItems: items, sharedBytes: bytes };
  };

  const describe = () => {
    const { items, bytes, sharedItems, sharedBytes } = totals();
    if (items === 0) return 'The directory is empty. New files will be shared as they appear.';
    return `${sharedItems} of ${plural(items, 'item')} selected · ${formatBytes(sharedBytes)} of ${formatBytes(bytes)}`;
  };

  const toggle = (node) => {
    if (stateOf(node.path) === 'checked') uncheck(node.path);
    else check(node.path);
    refresh();
    onChange?.();
  };

  const renderChildren = (node, list) => {
    for (const child of node.children || []) list.append(renderNode(child));
  };

  const renderNode = (node) => {
    const isDir = node.kind === 'dir';
    const item = h('li', { role: 'treeitem' });
    const id = `tree-${nodes.size}-${Math.random().toString(36).slice(2, 8)}`;
    let list = null;
    let twisty = null;

    if (isDir && node.children && node.children.length > 0) {
      twisty = h('button', { type: 'button', class: 'twisty', 'aria-expanded': 'false', 'aria-label': `Expand ${node.name}` }, icon('chevron'));
      twisty.addEventListener('click', () => setExpanded(node, twisty.getAttribute('aria-expanded') !== 'true'));
    }

    const checkbox = node.syncable ? h('input', { type: 'checkbox', id, checked: true }) : null;
    checkbox?.addEventListener('change', () => toggle(node));

    const kindIcon = isDir ? icon('folder', 'kind-dir') : node.kind === 'file' ? icon('file', 'kind-file') : icon('link', 'kind-file');
    const meta =
      node.kind === 'file'
        ? formatBytes(node.size)
        : isDir
          ? node.error
            ? `cannot read (${node.error.toLowerCase()})`
            : plural(node.count, 'item')
          : 'not synced (link or special file)';

    const row = h(
      'div',
      { class: `tree-row${node.syncable ? '' : ' unsyncable'}` },
      twisty || h('span', { class: 'twisty-spacer' }),
      checkbox,
      h('label', { for: checkbox ? id : null }, kindIcon, h('span', { class: 'tree-name', text: node.name, title: node.path || node.name }), h('span', { class: 'tree-size', text: meta })),
    );
    item.append(row);
    if (twisty) {
      list = h('ul', { role: 'group', hidden: true });
      item.append(list);
    }
    rendered.set(node.path, { row, checkbox, list, twisty, filled: false });
    return item;
  };

  const setExpanded = (node, expanded) => {
    const parts = rendered.get(node.path);
    if (!parts?.list || !parts.twisty) return;
    if (expanded && !parts.filled) {
      renderChildren(node, parts.list);
      parts.filled = true;
      refresh();
    }
    parts.list.hidden = !expanded;
    parts.twisty.setAttribute('aria-expanded', String(expanded));
    parts.twisty.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${node.name}`);
  };

  return {
    el: box,
    summary,

    /** Replace the whole tree (a new directory was verified). */
    setData(tree) {
      nodes.clear();
      rendered.clear();
      excluded = new Set();
      root = tree;
      index(tree, null);
      tree.syncable = true;
      const top = h('ul', { class: 'tree', role: 'tree', 'aria-label': 'Content to share' }, renderNode(tree));
      box.replaceChildren(top);
      setExpanded(tree, true);
      refresh();
    },

    /** Check everything. */
    selectAll() {
      excluded = new Set();
      refresh();
      onChange?.();
    },

    /** Uncheck everything below the root (the root itself stays, so new files are shared). */
    selectNone() {
      excluded = new Set((root?.children || []).filter((child) => child.syncable).map((child) => child.path));
      refresh();
      onChange?.();
    },

    /** Expand every directory (renders everything). */
    expandAll() {
      for (const node of nodes.values()) if (node.kind === 'dir') setExpanded(node, true);
    },

    collapseAll() {
      for (const node of nodes.values()) if (node.kind === 'dir' && node !== root) setExpanded(node, false);
    },

    /** Excluded paths, as the server expects them. */
    excluded() {
      return [...excluded].sort();
    },

    /** True when at least the root directory itself is shared. */
    get hasSelection() {
      return root !== null && !excluded.has('');
    },

    get totals() {
      return totals();
    },

    clear() {
      nodes.clear();
      rendered.clear();
      excluded = new Set();
      root = null;
      box.replaceChildren();
      summary.textContent = '';
    },
  };
}
