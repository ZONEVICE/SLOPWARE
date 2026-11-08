/**
 * Themes. The palettes live in styles/themes.css as CSS custom properties on
 * <html data-theme="...">; this module lists them, applies one, remembers
 * the choice in localStorage, and reads the variables back for the editors
 * that need concrete colors (Monaco, xterm).
 *
 * First visit: the system preference picks Dark or Light. Afterwards the
 * saved choice wins (public/boot.js applies it before first paint).
 */
import { store } from './store.js';

export const THEMES = [
  { id: 'dark', name: 'Dark', kind: 'dark', swatch: ['#18191c', '#4cc38a', '#d7d9de'] },
  { id: 'light', name: 'Light', kind: 'light', swatch: ['#f4f5f7', '#1a7f4e', '#1f2328'] },
  { id: 'kirby', name: 'Kirby', kind: 'light', swatch: ['#ffe1ee', '#ff3d8b', '#5a2048'] },
  { id: 'gorbino', name: 'Gorbino', kind: 'dark', swatch: ['#0b2e18', '#ff2bd6', '#6dff3a'] },
  { id: 'oled', name: 'Dark OLED', kind: 'dark', swatch: ['#000000', '#ffffff', '#6b6b6b'] },
  { id: 'dos', name: 'Dos', kind: 'dark', swatch: ['#0000aa', '#aaaaaa', '#ffff55'] },
  { id: 'nuclear', name: 'Nuclear', kind: 'dark', swatch: ['#020c03', '#39ff6a', '#157a30'] },
  { id: 'ambar', name: 'Ambar', kind: 'dark', swatch: ['#0d0700', '#ffb000', '#7a5000'] },
  { id: 'eyeburned', name: 'Eye Burned', kind: 'light', swatch: ['#ffffff', '#0000ff', '#000000'] },
];

const KEY = 'theme';

export function currentTheme() {
  const id = document.documentElement.getAttribute('data-theme');
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

/** True when the user picked a theme explicitly at some point. */
export function hasSavedTheme() {
  return THEMES.some((t) => t.id === store.get(KEY));
}

/** Applies a theme; `remember` saves it as the user's choice. */
export function applyTheme(id, { remember = true } = {}) {
  const theme = THEMES.find((t) => t.id === id) || THEMES[0];
  document.documentElement.setAttribute('data-theme', theme.id);
  if (remember) store.set(KEY, theme.id);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', cssVar('--topbar-bg') || theme.swatch[0]);
  return theme;
}

/** Follows the system light/dark preference until the user chooses. */
export function followSystemTheme(onChange) {
  const query = window.matchMedia('(prefers-color-scheme: light)');
  query.addEventListener?.('change', () => {
    if (hasSavedTheme()) return;
    applyTheme(query.matches ? 'light' : 'dark', { remember: false });
    onChange?.();
  });
}

/** The value of a CSS custom property on <html>, trimmed. */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A CSS variable as a 6- or 8-digit hex color (what Monaco accepts). */
export function hexVar(name, fallback = '#000000') {
  const value = cssVar(name);
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) return `#${[...value.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  return fallback;
}

/** The xterm.js theme for the current palette. */
export function terminalTheme() {
  const v = (n) => hexVar(n);
  return {
    background: v('--term-bg'),
    foreground: v('--term-fg'),
    cursor: v('--term-cursor'),
    cursorAccent: v('--term-bg'),
    selectionBackground: v('--term-selection'),
    black: v('--ansi-black'),
    red: v('--ansi-red'),
    green: v('--ansi-green'),
    yellow: v('--ansi-yellow'),
    blue: v('--ansi-blue'),
    magenta: v('--ansi-magenta'),
    cyan: v('--ansi-cyan'),
    white: v('--ansi-white'),
    brightBlack: v('--ansi-bright-black'),
    brightRed: v('--ansi-bright-red'),
    brightGreen: v('--ansi-bright-green'),
    brightYellow: v('--ansi-bright-yellow'),
    brightBlue: v('--ansi-bright-blue'),
    brightMagenta: v('--ansi-bright-magenta'),
    brightCyan: v('--ansi-bright-cyan'),
    brightWhite: v('--ansi-bright-white'),
  };
}
