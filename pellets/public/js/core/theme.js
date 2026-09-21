/**
 * Light / dark theme.
 *
 * DARK IS THE DEFAULT, as the specification requires: no stored preference and
 * no system query means dark. The choice is written to `localStorage` for an
 * instant, flash-free application on the next load (see the inline bootstrap in
 * index.html) and mirrored into the server session so every tab agrees.
 */
import { publish } from './state.js';

const STORAGE_KEY = 'pellets.theme';

/** @returns {'dark'|'light'} */
export function getTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/**
 * Apply a theme locally.
 * @param {'dark'|'light'} theme
 */
export function applyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = value;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', value === 'light' ? 'light dark' : 'dark light');
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Private mode or blocked storage: the theme still applies for this page.
  }
  publish('theme', value);
  return value;
}

/** @returns {'dark'|'light'} The theme now in effect. */
export function toggleTheme() {
  return applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

/** The stored preference, or null when the client has never chosen. */
export function storedTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}
