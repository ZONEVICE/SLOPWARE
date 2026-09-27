/**
 * A virtual list of rows of any height: only the rows near the viewport
 * exist in the DOM, so an album of 100,000 files scrolls like one of 100.
 *
 * A row is { key, height, render() -> Element, data?, destroy?(el) }. Rows
 * are absolutely positioned inside one tall element. When setRows() is called
 * again, a mounted row whose key is unchanged and whose `data` array holds
 * the very same objects is kept as it is (its images are not reloaded).
 */
import { h, rafThrottle } from './dom.js';

export class VirtualList {
  constructor(scroller, { overscan = 900, gap = 0, onScroll = null } = {}) {
    this.scroller = scroller;
    this.overscan = overscan;
    this.gap = gap;
    this.onScrollCallback = onScroll;
    this.content = h('div', { class: 'vlist', role: 'presentation' });
    scroller.append(this.content);
    this.rows = [];
    this.tops = [];
    this.total = 0;
    this.mounted = new Map(); // key -> { el, row }
    this.renderSoon = rafThrottle(() => this.render());
    this.handleScroll = () => {
      this.renderSoon();
      if (this.onScrollCallback) this.onScrollCallback();
    };
    scroller.addEventListener('scroll', this.handleScroll, { passive: true });
    this.resizeObserver = new ResizeObserver(this.renderSoon);
    this.resizeObserver.observe(scroller);
  }

  setRows(rows) {
    this.rows = rows;
    this.tops = new Array(rows.length);
    let top = 0;
    for (let index = 0; index < rows.length; index += 1) {
      this.tops[index] = top;
      top += rows[index].height + (index < rows.length - 1 ? this.gap : 0);
    }
    this.total = top;
    this.content.style.height = `${top}px`;
    const byKey = new Map(rows.map((row, index) => [row.key, index]));
    for (const [key, entry] of this.mounted) {
      const index = byKey.get(key);
      if (index === undefined || !sameData(entry.row, rows[index]) || entry.row.height !== rows[index].height) {
        this._unmount(key, entry);
      }
    }
    this.render();
  }

  /** Offset of the list's first row inside the scroller (content may sit above it). */
  get offset() {
    return this.content.offsetTop;
  }

  render() {
    const viewTop = this.scroller.scrollTop - this.offset;
    const viewHeight = this.scroller.clientHeight || window.innerHeight;
    const from = viewTop - this.overscan;
    const to = viewTop + viewHeight + this.overscan;
    const first = this.indexAt(Math.max(0, from));
    const wanted = new Set();
    for (let index = first; index < this.rows.length && this.tops[index] <= to; index += 1) {
      const row = this.rows[index];
      wanted.add(row.key);
      let entry = this.mounted.get(row.key);
      if (!entry) {
        const el = row.render();
        el.classList.add('vrow');
        el.style.height = `${row.height}px`;
        entry = { el, row };
        this.mounted.set(row.key, entry);
        this.content.append(el);
      } else {
        entry.row = row;
      }
      entry.el.style.transform = `translateY(${this.tops[index]}px)`;
    }
    for (const [key, entry] of this.mounted) {
      if (!wanted.has(key)) this._unmount(key, entry);
    }
  }

  /** Index of the row at `offset` pixels from the top of the list. */
  indexAt(offset) {
    let low = 0;
    let high = this.rows.length - 1;
    let found = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (this.tops[middle] <= offset) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  }

  /** The index of the first row visible at the top of the scroller. */
  firstVisibleIndex() {
    return this.indexAt(Math.max(0, this.scroller.scrollTop - this.offset + 1));
  }

  scrollToIndex(index, { behavior = 'auto', align = 'start' } = {}) {
    if (!this.rows.length) return;
    const clamped = Math.max(0, Math.min(index, this.rows.length - 1));
    let top = this.tops[clamped] + this.offset;
    if (align === 'center') top -= (this.scroller.clientHeight - this.rows[clamped].height) / 2;
    if (align === 'nearest') {
      const viewTop = this.scroller.scrollTop;
      const viewBottom = viewTop + this.scroller.clientHeight;
      const rowBottom = top + this.rows[clamped].height;
      if (top >= viewTop && rowBottom <= viewBottom) return;
      if (rowBottom > viewBottom) top = rowBottom - this.scroller.clientHeight;
    }
    this.scroller.scrollTo({ top: Math.max(0, top), behavior });
  }

  _unmount(key, entry) {
    if (entry.row.destroy) entry.row.destroy(entry.el);
    entry.el.remove();
    this.mounted.delete(key);
  }

  destroy() {
    this.scroller.removeEventListener('scroll', this.handleScroll);
    this.resizeObserver.disconnect();
    for (const [key, entry] of this.mounted) this._unmount(key, entry);
    this.content.remove();
  }
}

function sameData(a, b) {
  if (!a.data && !b.data) return true;
  if (!a.data || !b.data || a.data.length !== b.data.length) return false;
  for (let index = 0; index < a.data.length; index += 1) if (a.data[index] !== b.data[index]) return false;
  return a.sig === b.sig;
}
