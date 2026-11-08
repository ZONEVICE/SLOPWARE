/**
 * The quick picker: the box at the top of the editor used by the command
 * palette, "Go to File", "Go to Line" and every "choose one of these" list.
 *
 *   quickPick({
 *     placeholder, value,
 *     items: [...] | (query) => items | Promise<items>,
 *     onAccept(item, query), onQuery?(query) -> bool (handled, keep open),
 *     onSelect?(item)   the highlighted item changed (previews),
 *     onCancel?()       closed without accepting,
 *   })
 *
 * Items: { label, description?, detail?, icon?, iconColor?, keys?,
 * positions? (characters of `label` to highlight), separator?, picked?
 * (initially highlighted) }.
 */
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';

let current = null;

export function closeQuickPick() {
  current?.close();
}

export function quickPick({ placeholder = '', value = '', items, onAccept, onQuery, onSelect, onCancel, emptyText = 'No results' }) {
  closeQuickPick();
  const previousFocus = document.activeElement;
  const input = h('input.quickpick-input', {
    type: 'text',
    value,
    placeholder,
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': placeholder,
  });
  const list = h('div.quickpick-list', { role: 'listbox' });
  const box = h('div.quickpick', { role: 'dialog' }, input, list);
  const overlay = h('div.quickpick-overlay', {}, box);
  let visible = [];
  let selected = 0;
  let generation = 0;

  let accepted = false;
  const close = (restoreFocus = true) => {
    if (current?.box !== box) return;
    current = null;
    overlay.remove();
    if (!accepted) onCancel?.();
    if (restoreFocus && previousFocus?.focus) previousFocus.focus({ preventScroll: true });
  };

  function renderLabel(item) {
    const label = h('span.qp-label');
    const positions = new Set(item.positions || []);
    if (!positions.size) {
      label.textContent = item.label;
      return label;
    }
    let run = '';
    let inMatch = false;
    const flush = () => {
      if (!run) return;
      label.append(inMatch ? h('mark', { text: run }) : document.createTextNode(run));
      run = '';
    };
    [...item.label].forEach((ch, i) => {
      const match = positions.has(i);
      if (match !== inMatch) {
        flush();
        inMatch = match;
      }
      run += ch;
    });
    flush();
    return label;
  }

  function render() {
    list.replaceChildren();
    if (!visible.length) {
      list.append(h('div.qp-empty', { text: emptyText }));
      return;
    }
    visible.forEach((item, index) => {
      if (item.separator) {
        list.append(h('div.qp-separator', { text: item.label || '' }));
        return;
      }
      const row = h(
        'div.qp-item',
        { role: 'option', 'aria-selected': String(index === selected), class: index === selected ? 'selected' : '' },
        item.icon ? icon(item.icon, 'qp-icon') : h('span.qp-icon-space'),
        h('div.qp-text', {}, h('div.qp-main', {}, renderLabel(item), item.description ? h('span.qp-desc', { text: item.description }) : null),
          item.detail ? h('div.qp-detail', { text: item.detail }) : null),
        item.keys ? h('span.qp-keys', { text: item.keys }) : null,
      );
      if (item.iconColor) row.style.setProperty('--qp-icon-color', `var(${item.iconColor})`);
      row.addEventListener('pointerdown', (event) => event.preventDefault());
      row.addEventListener('click', () => accept(index));
      row.addEventListener('pointermove', () => {
        if (selected !== index) {
          selected = index;
          markSelected();
        }
      });
      list.append(row);
    });
    markSelected();
  }

  function markSelected() {
    const rows = list.querySelectorAll('.qp-item, .qp-separator');
    rows.forEach((row, i) => {
      const on = i === selected;
      row.classList.toggle('selected', on);
      row.setAttribute('aria-selected', String(on));
      if (on) row.scrollIntoView({ block: 'nearest' });
    });
    if (visible[selected] && !visible[selected].separator) onSelect?.(visible[selected]);
  }

  function move(delta) {
    if (!visible.length) return;
    let next = selected;
    for (let i = 0; i < visible.length; i += 1) {
      next = (next + delta + visible.length) % visible.length;
      if (!visible[next].separator) break;
    }
    selected = next;
    markSelected();
  }

  async function update() {
    const query = input.value;
    if (onQuery && onQuery(query)) return;
    const mine = ++generation;
    const result = typeof items === 'function' ? await items(query) : items;
    if (mine !== generation || current?.box !== box) return;
    visible = result || [];
    selected = visible.findIndex((i) => i.picked);
    if (selected < 0) selected = visible.findIndex((i) => !i.separator);
    if (selected < 0) selected = 0;
    render();
  }

  function accept(index = selected) {
    const item = visible[index];
    if (!item || item.separator) return;
    const query = input.value;
    accepted = true;
    close(false);
    onAccept?.(item, query);
  }

  input.addEventListener('input', update);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if (event.key === 'PageDown') move(8);
    else if (event.key === 'PageUp') move(-8);
    else if (event.key === 'Enter') accept();
    else if (event.key === 'Escape') close();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });

  current = { box, close };
  document.body.append(overlay);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  update();
  return {
    close,
    setValue(text) {
      input.value = text;
      update();
    },
    refresh: update,
  };
}
