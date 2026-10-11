import { STORAGE_KEYS } from '../core/store.js';
import { el } from './dom.js';

/**
 * Appearance themes. A theme is a palette of CSS tokens in css/styles.css,
 * selected by data-theme on <html>; scripts and rules never hardcode colors.
 * To add one, copy a palette block in the stylesheet, change its values, and
 * append an entry here with the same id; the core tests check both sides.
 * index.html applies the saved theme before the first paint; this module
 * validates it and owns every later change. The theme is a per-browser display
 * preference on its own storage key, so configuration export, import, and
 * restore defaults never touch it.
 */
export const THEMES = Object.freeze([
  Object.freeze({ id: 'light', label: 'Light', description: 'Bright, soft surfaces. The default.' }),
  Object.freeze({ id: 'dark', label: 'Dark', description: 'Dimmed surfaces for low light.' }),
  Object.freeze({ id: 'oled', label: 'Dark OLED', description: 'Pure black and white for OLED screens.' }),
]);
export const DEFAULT_THEME = 'light';

const isTheme = id => THEMES.some(theme => theme.id === id);

/** Tests inject `storage` (synchronous getItem/setItem) and a detached `root`. */
export function createThemeController(options = {}) {
  const root = options.root ?? document.documentElement;
  let storage = null, current = DEFAULT_THEME;
  try { storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage; }
  catch { /* Blocked storage: themes still apply but are not remembered. */ }
  const saved = () => {
    try { const id = storage?.getItem(STORAGE_KEYS.theme); return isTheme(id) ? id : DEFAULT_THEME; }
    catch { return DEFAULT_THEME; }
  };
  function apply(id) {
    current = id;
    root.dataset.theme = id;
    // Mobile browsers tint their toolbar with theme-color; follow the page.
    const meta = root.ownerDocument.querySelector('meta[name="theme-color"]');
    const page = meta && getComputedStyle(root).getPropertyValue('--page').trim();
    if (page) meta.content = page;
  }
  apply(saved());
  return {
    themes: THEMES,
    get current() { return current; },
    /** Apply a theme now and remember it. Returns false if storage refuses the write. */
    set(id) {
      if (!isTheme(id)) throw new Error(`Unknown theme: ${id}.`);
      apply(id);
      try { storage.setItem(STORAGE_KEYS.theme, id); return true; } catch { return false; }
    },
    /** Re-apply the saved theme, for example after another tab changed it. */
    sync() { apply(saved()); return current; },
  };
}

/** Radio cards for the settings view; each preview paints with its own palette. */
export function createThemePicker(theme, { labelledBy, onSaveError } = {}) {
  const inputs = [];
  const element = el('div', { class: 'theme-options', role: 'radiogroup', 'aria-labelledby': labelledBy },
    theme.themes.map(({ id, label, description }) => {
      const input = el('input', { type: 'radio', name: 'theme', value: id, 'aria-labelledby': `theme-${id}-label`, 'aria-describedby': `theme-${id}-help`, onChange: () => { if (input.checked && !theme.set(id)) onSaveError?.(); } });
      inputs.push(input);
      return el('label', { class: 'theme-option' }, input,
        el('span', { class: 'theme-preview', dataset: { theme: id }, 'aria-hidden': 'true' }, el('span', { class: 'theme-preview-card' }, el('span'), el('span'), el('span'))),
        el('span', { class: 'theme-option-label', id: `theme-${id}-label`, text: label }),
        el('span', { class: 'field-help', id: `theme-${id}-help`, text: description }));
    }));
  const update = () => { for (const input of inputs) input.checked = input.value === theme.current; };
  update();
  return { element, update };
}
