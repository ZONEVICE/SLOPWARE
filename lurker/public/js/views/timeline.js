/**
 * "Timeline": everything grouped by day, month or year, newest first, with
 * the current period pinned at the top and a rail of years to jump through.
 * Dates follow the filter panel's date basis (taken, created or modified).
 */
import { h } from '../core/dom.js';
import { plural, wallDay, wallMonth, wallYear } from '../core/format.js';
import { dateOf, sortItems } from '../core/query.js';
import { VirtualList } from '../core/virtual.js';
import { contentWidth, tileRows, watchWidth } from './shared.js';

const HEAD = 46;
const GROUPS = [
  { key: 'day', label: 'Day' },
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' },
];

function periodOf(wall, unit) {
  const date = new Date(wall * 1000);
  const year = date.getUTCFullYear();
  if (unit === 'year') return { key: `${year}`, start: Date.UTC(year, 0, 1) / 1000, year };
  const month = date.getUTCMonth();
  if (unit === 'month') return { key: `${year}-${month}`, start: Date.UTC(year, month, 1) / 1000, year };
  const day = date.getUTCDate();
  return { key: `${year}-${month}-${day}`, start: Date.UTC(year, month, day) / 1000, year };
}

function labelOf(start, unit) {
  if (unit === 'year') return wallYear(start);
  if (unit === 'month') return wallMonth(start);
  const text = wallDay(start);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** [{ key, label, year, items }] in display order; undated items last. */
export function groupByPeriod(items, unit, basis, direction = 'desc') {
  const groups = new Map();
  const undated = [];
  for (const item of items) {
    const wall = dateOf(item, basis);
    if (wall === null) {
      undated.push(item);
      continue;
    }
    const period = periodOf(wall, unit);
    let group = groups.get(period.key);
    if (!group) {
      group = { key: period.key, start: period.start, year: period.year, label: labelOf(period.start, unit), items: [] };
      groups.set(period.key, group);
    }
    group.items.push(item);
  }
  const ordered = [...groups.values()].sort((a, b) => (direction === 'asc' ? a.start - b.start : b.start - a.start));
  if (undated.length) ordered.push({ key: 'undated', start: null, year: null, label: 'No date', items: undated });
  return ordered;
}

export default {
  id: 'timeline',
  label: 'Timeline',
  icon: 'calendar',
  tiles: true,

  create(ctx) {
    const groupControl = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Group by' });
    const meta = h('span', { class: 'meta' });
    const head = h('div', { class: 'pane-head' }, h('h2', { text: 'Timeline' }), meta, h('span', { class: 'spacer' }), groupControl);
    const scroller = h('div', { class: 'scroller', tabindex: '-1' });
    const floating = h('div', { class: 'floating-head', 'aria-hidden': 'true', hidden: true });
    const rail = h('nav', { class: 'rail', 'aria-label': 'Years' });
    const empty = h('div', { class: 'view-empty' });
    const body = h('div', { class: 'view-col timeline-host' }, scroller, floating, rail);
    const el = h('div', { class: 'view-col' }, head, body, empty);
    let rows = [];
    let groups = [];
    let sequence = [];
    let width = 0;
    let currentYear = null;

    const updateFloating = () => {
      if (!rows.length) {
        floating.hidden = true;
        return;
      }
      const index = list.firstVisibleIndex();
      const row = rows[Math.min(index, rows.length - 1)];
      const group = groups[row.group];
      const beyondHead = scroller.scrollTop > HEAD;
      floating.hidden = !beyondHead || !group;
      if (group) {
        floating.replaceChildren(h('span', { text: group.label }), h('span', { class: 'meta', text: plural(group.items.length, 'item') }));
        if (group.year !== currentYear) {
          currentYear = group.year;
          for (const button of rail.children) button.classList.toggle('current', button.dataset.year === String(group.year));
        }
      }
    };
    const list = new VirtualList(scroller, { overscan: 900, onScroll: () => requestAnimationFrame(updateFloating) });

    const render = () => {
      if (!width) width = contentWidth(scroller);
      const unit = GROUPS.some((group) => group.key === ctx.params.get('group')) ? ctx.params.get('group') : 'month';
      const basis = ctx.filters.dateBasis;
      const direction = ctx.sort.key === 'date' ? ctx.sort.dir : 'desc';
      groupControl.replaceChildren(
        ...GROUPS.map((group) =>
          h('button', {
            type: 'button',
            'aria-pressed': String(group.key === unit),
            text: group.label,
            onClick: () => ctx.patch({ group: group.key === 'month' ? null : group.key }),
          }),
        ),
      );
      const ordered = sortItems(ctx.items, 'date', direction, { dateBasis: basis });
      groups = groupByPeriod(ordered, unit, basis, direction);
      sequence = groups.flatMap((group) => group.items);
      rows = [];
      groups.forEach((group, index) => {
        rows.push({
          key: `h:${unit}:${group.key}:${group.items.length}`,
          height: HEAD,
          group: index,
          header: true,
          render: () =>
            h('div', { class: 'section-head' }, h('h2', { text: group.label }), h('span', { class: 'meta', text: plural(group.items.length, 'item') })),
        });
        for (const row of tileRows(ctx, group.items, width, { prefix: `g${unit}${group.key}` })) {
          row.group = index;
          rows.push(row);
        }
      });
      const dated = groups.filter((group) => group.start !== null);
      meta.textContent = dated.length
        ? `${dated[direction === 'asc' ? 0 : dated.length - 1].label} – ${dated[direction === 'asc' ? dated.length - 1 : 0].label}`
        : '';
      const years = [...new Set(dated.map((group) => group.year))];
      rail.replaceChildren(
        ...years.map((year) =>
          h('button', {
            type: 'button',
            text: String(year),
            dataset: { year: String(year) },
            onClick: () => list.scrollToIndex(rows.findIndex((row) => row.header && groups[row.group].year === year)),
          }),
        ),
      );
      rail.hidden = years.length < 2;
      currentYear = null;
      const emptyView = ctx.emptyState(ctx.items);
      empty.replaceChildren(...(emptyView ? [emptyView] : []));
      empty.hidden = !emptyView;
      body.hidden = Boolean(emptyView);
      list.setRows(rows);
      updateFloating();
    };

    const stop = watchWidth(scroller, (next) => {
      width = next;
      render();
    });

    return {
      el,
      update: render,
      sequence: () => sequence,
      reveal(item) {
        const index = rows.findIndex((row) => row.data && row.data.some((entry) => entry.id === item.id));
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
