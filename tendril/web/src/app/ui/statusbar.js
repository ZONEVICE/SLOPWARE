/**
 * The status bar. Features add items with
 * `app.statusbar.add({ id, side: 'left' | 'right', order, tip, onClick })`,
 * which returns the item's element; the feature keeps it up to date by
 * listening to bus events. Items with `onClick` are buttons.
 */
import { h } from '../core/dom.js';

export function createStatusBar(app, host) {
  const left = h('div.status-left');
  const right = h('div.status-right');
  const bar = h('footer.statusbar', { role: 'status' }, left, right);
  host.append(bar);
  const items = [];

  return {
    el: bar,
    add({ id, side = 'right', order = 50, tip, onClick, className = '' }) {
      const el = onClick
        ? h('button.status-item', { type: 'button', 'data-id': id, 'data-tip': tip || null, class: className, onclick: onClick })
        : h('span.status-item', { 'data-id': id, 'data-tip': tip || null, class: className });
      items.push({ el, side, order });
      const column = side === 'left' ? left : right;
      const siblings = items.filter((i) => i.side === side).sort((a, b) => a.order - b.order);
      column.replaceChildren(...siblings.map((i) => i.el));
      return el;
    },
  };
}
