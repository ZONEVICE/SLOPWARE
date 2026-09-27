/**
 * "Folders": the album one directory at a time, like a file manager made of
 * pictures. Subfolders appear as cards with a cover and their counts; the
 * media directly inside the current folder follow (or everything below it,
 * with "Include subfolders").
 */
import { createTile, releaseTiles } from '../components/tile.js';
import { h } from '../core/dom.js';
import { plural } from '../core/format.js';
import { icon } from '../core/icons.js';
import { VirtualList } from '../core/virtual.js';
import { contentWidth, tileRows, watchWidth } from './shared.js';

const HEAD = 44;
const CARD_GAP = 12;

export function folderSummary(stats) {
  const parts = [];
  if (stats.images) parts.push(plural(stats.images, 'image'));
  if (stats.videos) parts.push(plural(stats.videos, 'video'));
  return parts.join(' · ') || 'Empty';
}

/**
 * Filtered counts and covers for each folder that contains matching items,
 * counting everything below it. Covers are the first items in display order.
 */
export function folderIndex(catalog, items) {
  const stats = new Map();
  for (const item of items) {
    let folder = catalog.folders.get(item.folderId);
    let guard = 0;
    while (folder && guard < 512) {
      let entry = stats.get(folder.id);
      if (!entry) {
        entry = { images: 0, videos: 0, count: 0, covers: [] };
        stats.set(folder.id, entry);
      }
      entry.count += 1;
      if (item.kind === 'video') entry.videos += 1;
      else entry.images += 1;
      if (entry.covers.length < 3) entry.covers.push(item);
      folder = folder.parentId === null ? null : catalog.folders.get(folder.parentId);
      guard += 1;
    }
  }
  return stats;
}

/** Items of `folderId` (and below, if `recursive`), in the order of `items`. */
export function itemsOf(catalog, items, folderId, recursive) {
  if (!recursive) return items.filter((item) => item.folderId === folderId);
  return items.filter((item) => {
    let folder = catalog.folders.get(item.folderId);
    let guard = 0;
    while (folder && guard < 512) {
      if (folder.id === folderId) return true;
      folder = folder.parentId === null ? null : catalog.folders.get(folder.parentId);
      guard += 1;
    }
    return false;
  });
}

export function currentFolder(ctx) {
  const wanted = Number(ctx.params.get('folder'));
  const root = ctx.catalog.derived().root;
  if (Number.isInteger(wanted) && ctx.catalog.folders.has(wanted)) return ctx.catalog.folders.get(wanted);
  return root;
}

export default {
  id: 'folders',
  label: 'Folders',
  icon: 'folder',
  tiles: true,

  create(ctx) {
    const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Folder path' });
    const scroller = h('div', { class: 'scroller', tabindex: '-1' });
    const empty = h('div', { class: 'view-empty' });
    const el = h('div', { class: 'view-col' }, crumbs, scroller, empty);
    const list = new VirtualList(scroller, { overscan: 900 });
    let width = 0;
    let shown = [];
    let rows = [];

    const go = (folder) => ctx.patch({ folder: folder.id === ctx.catalog.derived().root?.id ? null : folder.id }, { replace: false });

    const renderCrumbs = (folder, recursive) => {
      const chain = ctx.catalog.ancestry(folder.id);
      const parts = [];
      chain.forEach((entry, index) => {
        if (index) parts.push(h('span', { class: 'sep', 'aria-hidden': 'true' }, icon('chevron-right', { size: 14 })));
        const label = entry.parentId === null ? ctx.albumName() : entry.name;
        parts.push(
          h(
            'button',
            { type: 'button', 'aria-current': index === chain.length - 1 ? 'page' : null, onClick: () => go(entry) },
            index === 0 ? icon('home', { size: 16 }) : null,
            h('span', { text: label }),
          ),
        );
      });
      parts.push(h('span', { class: 'spacer' }));
      parts.push(
        h(
          'label',
          { class: 'switch small-switch' },
          h('span', { class: 'muted', text: 'Include subfolders' }),
          h('input', {
            type: 'checkbox',
            checked: recursive,
            onChange: (event) => ctx.patch({ sub: event.target.checked ? '1' : null }),
          }),
        ),
      );
      crumbs.replaceChildren(...parts);
    };

    const render = () => {
      if (!width) width = contentWidth(scroller);
      const folder = currentFolder(ctx);
      if (!folder) {
        rows = [];
        list.setRows(rows);
        return;
      }
      const recursive = ctx.params.get('sub') === '1';
      renderCrumbs(folder, recursive);
      const stats = folderIndex(ctx.catalog, ctx.items);
      const children = (ctx.catalog.derived().children.get(folder.id) || []).filter((child) => stats.has(child.id));
      shown = itemsOf(ctx.catalog, ctx.items, folder.id, recursive);
      rows = [];

      if (children.length && !recursive) {
        rows.push(headRow('f-head', 'Folders', plural(children.length, 'folder')));
        const target = Math.max(170, ctx.tileSize * 1.35);
        const columns = Math.max(1, Math.floor((width + CARD_GAP) / (target + CARD_GAP)));
        const cardWidth = Math.floor((width - CARD_GAP * (columns - 1)) / columns);
        const coverHeight = Math.round(cardWidth * 0.62);
        for (let start = 0; start < children.length; start += columns) {
          const slice = children.slice(start, start + columns);
          rows.push({
            key: `f:${slice.map((child) => child.id).join(',')}:${cardWidth}`,
            height: coverHeight + 56 + CARD_GAP,
            data: slice.map((child) => stats.get(child.id).covers[0]),
            sig: `${ctx.supportVersion}:${slice.map((child) => stats.get(child.id).count).join(',')}`,
            render: () =>
              h(
                'div',
                { class: 'folder-row' },
                slice.map((child) => folderCard(ctx, child, stats.get(child.id), cardWidth, coverHeight, () => go(child))),
              ),
            destroy: releaseTiles,
          });
        }
      }
      if (shown.length) {
        const title = recursive
          ? `Everything in ${folder.parentId === null ? ctx.albumName() : folder.name}`
          : children.length
            ? `In ${folder.parentId === null ? ctx.albumName() : folder.name}`
            : folder.parentId === null
              ? ctx.albumName()
              : folder.name;
        rows.push(headRow('i-head', title, plural(shown.length, 'item')));
        rows.push(...tileRows(ctx, shown, width, { prefix: `i${folder.id}` }));
      }
      const emptyView = rows.length ? null : ctx.emptyState(ctx.items);
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
      el,
      update: render,
      sequence: () => shown,
      reveal(item) {
        const index = rows.findIndex((row) => row.key.startsWith('i') && row.data?.some((entry) => entry.id === item.id));
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

function headRow(key, title, meta) {
  return {
    key: `${key}:${title}:${meta}`,
    height: HEAD,
    render: () => h('div', { class: 'section-head' }, h('h2', { text: title }), h('span', { class: 'meta', text: meta })),
  };
}

function folderCard(ctx, folder, stats, width, coverHeight, open) {
  // Three items make a mosaic (one large, two small); fewer show just the first.
  const covers = stats.covers.length >= 3 ? stats.covers.slice(0, 3) : stats.covers.slice(0, 1);
  const cover = h('span', { class: ['folder-cover', covers.length === 1 ? 'single' : ''] });
  cover.style.height = `${coverHeight}px`;
  const tileContext = { albumId: ctx.albumId, open: () => {} };
  covers.forEach((item, index) => {
    const tileWidth = covers.length === 1 ? width : index === 0 ? Math.round(width * 0.66) : Math.round(width * 0.34);
    const tileHeight = covers.length === 1 || index === 0 ? coverHeight : Math.round(coverHeight / 2);
    cover.append(createTile(item, tileContext, { width: tileWidth, height: tileHeight, interactive: false }));
  });
  const card = h(
    'button',
    { type: 'button', class: 'folder-card', title: folder.name, onClick: open },
    cover,
    h(
      'span',
      { class: 'folder-info' },
      h('span', { class: 'name' }, icon('folder', { size: 16 }), h('span', { text: folder.name })),
      h('span', { class: 'meta', text: folderSummary(stats) }),
    ),
  );
  card.style.width = `${width}px`;
  card.style.height = `${coverHeight + 56}px`;
  return card;
}

