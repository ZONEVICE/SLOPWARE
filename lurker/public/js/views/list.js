/**
 * "Details": one row per file with its folder, type, size, dimensions,
 * duration and date. Clicking a column header sorts by it.
 */
import { createTile, releaseTiles } from '../components/tile.js';
import { h } from '../core/dom.js';
import { bytes, duration, wallDateTime } from '../core/format.js';
import { icon } from '../core/icons.js';
import { dateOf, SORTS } from '../core/query.js';
import { VirtualList } from '../core/virtual.js';

const ROW = 52;

const COLUMNS = [
  { key: null, label: '', class: 'col-thumb' },
  { key: 'name', label: 'Name', class: 'col-name' },
  { key: 'folder', label: 'Folder', class: 'col-folder' },
  { key: 'type', label: 'Type', class: 'col-type' },
  { key: 'size', label: 'Size', class: 'col-size' },
  { key: 'pixels', label: 'Dimensions', class: 'col-dims' },
  { key: 'duration', label: 'Duration', class: 'col-duration' },
  { key: 'date', label: 'Date', class: 'col-date' },
];

export default {
  id: 'list',
  label: 'Details',
  icon: 'list',
  tiles: false,

  create(ctx) {
    const head = h('div', { class: 'list-head', role: 'row' });
    const scroller = h('div', { class: 'scroller', tabindex: '-1', role: 'rowgroup' });
    const empty = h('div', { class: 'view-empty' });
    const el = h('div', { class: 'list-host', role: 'table', 'aria-label': 'Files' }, head, scroller, empty);
    const list = new VirtualList(scroller, { overscan: 700 });
    let rows = [];

    const renderHead = () => {
      head.replaceChildren(
        ...COLUMNS.map((column) => {
          if (!column.key) return h('span', { class: column.class });
          const sorted = ctx.sort.key === column.key;
          return h(
            'button',
            {
              type: 'button',
              class: [column.class, sorted ? 'sorted' : ''],
              role: 'columnheader',
              'aria-sort': sorted ? (ctx.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
              onClick: () => {
                const fallback = SORTS.find((sort) => sort.key === column.key).dir;
                const dir = sorted ? (ctx.sort.dir === 'asc' ? 'desc' : 'asc') : fallback;
                ctx.patch({ sort: column.key === 'date' ? null : column.key, dir: dir === fallback ? null : dir });
              },
            },
            h('span', { text: column.label }),
            sorted ? icon(ctx.sort.dir === 'asc' ? 'chevron-up' : 'chevron-down', { size: 13 }) : null,
          );
        }),
      );
    };

    const render = () => {
      renderHead();
      const items = ctx.items;
      const basis = ctx.filters.dateBasis;
      const tileContext = { albumId: ctx.albumId, open: ctx.open };
      rows = items.map((item) => ({
        key: `l:${item.id}`,
        height: ROW,
        data: [item],
        sig: ctx.supportVersion,
        render: () =>
          h(
            'div',
            { class: 'list-row', role: 'row', onClick: () => ctx.open(item) },
            createTile(item, tileContext, { width: 40, height: 40, small: true }),
            h('span', { class: 'cell name', text: item.name, title: item.name }),
            h('span', { class: 'cell col-folder', text: ctx.catalog.folderPath(item.folderId) || ctx.albumName(), title: ctx.catalog.folderPath(item.folderId) }),
            h('span', { class: 'cell col-type', text: item.format.label }),
            h('span', { class: 'cell col-size', text: bytes(item.size) }),
            h('span', { class: 'cell col-dims', text: item.width ? `${item.width} × ${item.height}` : '' }),
            h('span', { class: 'cell col-duration', text: duration(item.duration) }),
            h('span', { class: 'cell col-date', text: wallDateTime(dateOf(item, basis)) }),
          ),
        destroy: releaseTiles,
      }));
      const emptyView = ctx.emptyState(items);
      empty.replaceChildren(...(emptyView ? [emptyView] : []));
      empty.hidden = !emptyView;
      scroller.hidden = Boolean(emptyView);
      head.hidden = Boolean(emptyView);
      list.setRows(rows);
    };

    return {
      el,
      update: render,
      sequence: () => ctx.items,
      reveal(item) {
        const index = rows.findIndex((row) => row.data[0].id === item.id);
        if (index >= 0) list.scrollToIndex(index, { align: 'nearest' });
      },
      resetScroll() {
        scroller.scrollTop = 0;
      },
      destroy() {
        list.destroy();
      },
    };
  },
};
