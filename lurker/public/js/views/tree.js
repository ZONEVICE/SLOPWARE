/**
 * "Tree": the directory tree on the left, the selected folder's media on the
 * right. Only folders holding matching media appear, with their counts.
 */
import { h } from '../core/dom.js';
import { number, plural } from '../core/format.js';
import { icon } from '../core/icons.js';
import { VirtualList } from '../core/virtual.js';
import { currentFolder, folderIndex, folderSummary, itemsOf } from './folders.js';
import { contentWidth, tileRows, watchWidth } from './shared.js';

export default {
  id: 'tree',
  label: 'Tree',
  icon: 'tree',
  tiles: true,

  create(ctx) {
    const pane = h('nav', { class: 'tree-pane', role: 'tree', 'aria-label': 'Folders' });
    const title = h('h2');
    const meta = h('span', { class: 'meta' });
    const recursiveToggle = h('input', {
      type: 'checkbox',
      onChange: (event) => ctx.patch({ sub: event.target.checked ? '1' : null }),
    });
    const host = h('div', { class: 'tree-host' });
    const toggle = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn tree-toggle',
        title: 'Show folders',
        'aria-label': 'Show folders',
        onClick: () => host.classList.toggle('tree-open'),
      },
      icon('tree'),
    );
    const head = h(
      'div',
      { class: 'pane-head' },
      toggle,
      title,
      meta,
      h('span', { class: 'spacer' }),
      h('label', { class: 'switch small-switch' }, h('span', { class: 'muted', text: 'Include subfolders' }), recursiveToggle),
    );
    const scroller = h('div', { class: 'scroller', tabindex: '-1' });
    const empty = h('div', { class: 'view-empty' });
    host.append(pane, h('div', { class: 'tree-main' }, head, scroller, empty));
    const list = new VirtualList(scroller, { overscan: 900 });
    const expanded = new Set();
    let width = 0;
    let shown = [];
    let rows = [];
    let lastSelected = null;

    const select = (folder) => {
      host.classList.remove('tree-open');
      ctx.patch({ folder: folder.parentId === null ? null : folder.id }, { replace: false });
    };

    const renderTree = (selected, stats) => {
      const { children, root } = ctx.catalog.derived();
      const nodes = [];
      const walk = (folder, depth) => {
        const entry = stats.get(folder.id);
        if (!entry && folder.id !== selected.id) return;
        const kids = (children.get(folder.id) || []).filter((child) => stats.has(child.id) || child.id === selected.id);
        const open = expanded.has(folder.id);
        const node = h(
          'div',
          {
            class: 'tree-node',
            role: 'treeitem',
            'aria-selected': folder.id === selected.id ? 'true' : 'false',
            'aria-expanded': kids.length ? String(open) : null,
            tabindex: folder.id === selected.id ? '0' : '-1',
            title: folder.parentId === null ? ctx.albumRoot() : ctx.catalog.folderPath(folder.id),
            onClick: () => select(folder),
            onKeydown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                select(folder);
              } else if (event.key === 'ArrowRight' && kids.length && !open) {
                expanded.add(folder.id);
                render();
              } else if (event.key === 'ArrowLeft' && open) {
                expanded.delete(folder.id);
                render();
              }
            },
          },
          h(
            'button',
            {
              type: 'button',
              class: ['twisty', open ? 'open' : '', kids.length ? '' : 'leaf'],
              tabindex: '-1',
              'aria-label': open ? 'Collapse' : 'Expand',
              onClick: (event) => {
                event.stopPropagation();
                if (open) expanded.delete(folder.id);
                else expanded.add(folder.id);
                render();
              },
            },
            icon('chevron-right', { size: 14 }),
          ),
          icon(folder.id === selected.id ? 'folder-open' : 'folder', { size: 17, class: 'folder-icon' }),
          h('span', { class: 'label', text: folder.parentId === null ? ctx.albumName() : folder.name }),
          h('span', { class: 'count', text: entry ? number(entry.count) : '0' }),
        );
        node.style.paddingLeft = `${4 + depth * 14}px`;
        nodes.push(node);
        if (open) for (const child of kids) walk(child, depth + 1);
      };
      if (root) walk(root, 0);
      pane.replaceChildren(...nodes);
    };

    const render = () => {
      if (!width) width = contentWidth(scroller);
      const selected = currentFolder(ctx);
      if (!selected) {
        pane.replaceChildren();
        list.setRows([]);
        return;
      }
      if (lastSelected !== selected.id) {
        // Open the path down to the selection (a deep link, or a click in another view).
        for (const folder of ctx.catalog.ancestry(selected.id)) if (folder.id !== selected.id) expanded.add(folder.id);
        if (selected.parentId === null) expanded.add(selected.id);
        lastSelected = selected.id;
      }
      const recursive = ctx.params.get('sub') === '1';
      recursiveToggle.checked = recursive;
      const stats = folderIndex(ctx.catalog, ctx.items);
      renderTree(selected, stats);
      shown = itemsOf(ctx.catalog, ctx.items, selected.id, recursive);
      title.textContent = selected.parentId === null ? ctx.albumName() : selected.name;
      const entry = stats.get(selected.id);
      meta.textContent = recursive
        ? entry
          ? folderSummary(entry)
          : 'Empty'
        : `${plural(shown.length, 'item')} here${entry && entry.count > shown.length ? `, ${number(entry.count)} with subfolders` : ''}`;
      rows = tileRows(ctx, shown, width, { prefix: `t${selected.id}` });
      let emptyView = null;
      if (!shown.length) {
        emptyView = ctx.emptyState(ctx.items) || ctx.emptyNote(
          'folder',
          'Nothing directly in this folder',
          entry ? 'Its subfolders hold matching files: turn on "Include subfolders" or pick one on the left.' : 'No file in this folder matches the filters.',
        );
      }
      empty.replaceChildren(...(emptyView ? [emptyView] : []));
      empty.hidden = !emptyView;
      scroller.hidden = Boolean(emptyView);
      list.setRows(rows);
    };

    const stop = watchWidth(scroller, (next) => {
      width = next;
      render();
    });

    return {
      el: host,
      update: render,
      sequence: () => shown,
      reveal(item) {
        const index = rows.findIndex((row) => row.data.some((entry) => entry.id === item.id));
        if (index >= 0) list.scrollToIndex(index, { align: 'nearest' });
      },
      resetScroll() {
        scroller.scrollTop = 0;
      },
      destroy() {
        stop();
        list.destroy();
      },
    };
  },
};
