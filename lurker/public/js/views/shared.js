/** Helpers every tile-based view uses: rows of tiles, widths, empty states. */
import { releaseTiles, createTile } from '../components/tile.js';
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { justifiedRows, squareRows } from '../core/layout.js';

export const GAP = 4;

/** Usable width inside a scroller (without its horizontal padding). */
export function contentWidth(scroller) {
  const style = getComputedStyle(scroller);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  return Math.max(120, scroller.clientWidth - padding);
}

export function aspectOf(item) {
  return item.width && item.height ? item.width / item.height : item.kind === 'video' ? 16 / 9 : 4 / 3;
}

/**
 * Virtual-list rows of tiles for `items`. Clicking a tile opens the viewer on
 * the view's `sequence()`, so a view must return the items in display order.
 * @param {object} ctx the view context (albumId, open, layout, tileSize, supportVersion)
 */
export function tileRows(ctx, items, width, { prefix = 't', open = ctx.open } = {}) {
  const options = { target: ctx.tileSize, gap: GAP, aspect: aspectOf };
  const { rows } = ctx.layout === 'justified' ? justifiedRows(items, width, options) : squareRows(items, width, options);
  const tileContext = { albumId: ctx.albumId, open, onFailure: ctx.onFailure };
  return rows.map((row) => ({
    key: `${prefix}:${row.items[0].id}:${row.items.length}:${row.height}:${row.widths.join(',')}`,
    height: row.height + GAP,
    data: row.items,
    sig: ctx.supportVersion,
    render() {
      const el = h('div', { class: 'tile-row' });
      el.style.setProperty('--gap', `${GAP}px`);
      row.items.forEach((item, index) => {
        el.append(createTile(item, tileContext, { width: row.widths[index], height: row.height }));
      });
      return el;
    },
    destroy: releaseTiles,
  }));
}

export function emptyState({ glyph = 'image', title, text, action }) {
  return h(
    'div',
    { class: 'empty' },
    icon(glyph, { size: 44 }),
    h('h2', { text: title }),
    text ? h('p', { text }) : null,
    action || null,
  );
}

/** Watch a scroller's width and call `onChange` when it really changes. */
export function watchWidth(scroller, onChange) {
  let last = 0;
  const observer = new ResizeObserver(() => {
    const width = Math.round(contentWidth(scroller));
    if (width !== last) {
      last = width;
      onChange(width);
    }
  });
  observer.observe(scroller);
  return () => observer.disconnect();
}
