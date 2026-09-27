/**
 * "All": every image and video of the album in one grid, whatever folder it
 * lives in. This is the default view once a directory has been read.
 */
import { h } from '../core/dom.js';
import { VirtualList } from '../core/virtual.js';
import { contentWidth, tileRows, watchWidth } from './shared.js';

export default {
  id: 'grid',
  label: 'All',
  icon: 'grid',
  tiles: true,

  create(ctx) {
    const scroller = h('div', { class: 'scroller', tabindex: '-1' });
    const empty = h('div', { class: 'view-empty' });
    const el = h('div', { class: 'view-col' }, scroller, empty);
    const list = new VirtualList(scroller, { overscan: 1100 });
    let width = 0;
    let rows = [];

    const render = () => {
      if (!width) width = contentWidth(scroller);
      const items = ctx.items;
      const emptyView = ctx.emptyState(items);
      empty.replaceChildren(...(emptyView ? [emptyView] : []));
      empty.hidden = !emptyView;
      scroller.hidden = Boolean(emptyView);
      rows = emptyView ? [] : tileRows(ctx, items, width);
      list.setRows(rows);
    };
    const stop = watchWidth(scroller, (next) => {
      width = next;
      render();
    });

    return {
      el,
      update: render,
      sequence: () => ctx.items,
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
