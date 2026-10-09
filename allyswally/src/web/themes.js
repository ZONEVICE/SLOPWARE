// Theme definitions and runtime. A theme is only a palette selected by the
// [data-theme] attribute on <html>; swatches below drive the preview grid.
// The RGB theme animates a hue variable, honouring reduced-motion.

import { store } from './util.js';

export const THEMES = [
  { id: 'dark', name: 'Dark', swatch: ['#111318', '#5b8cff', '#262b35'] },
  { id: 'light', name: 'Light', swatch: ['#eef1f6', '#2f6bff', '#ffffff'] },
  { id: 'oled', name: 'Dark OLED', swatch: ['#000000', '#ffffff', '#0a0a0a'] },
  { id: 'rgb', name: 'RGB', swatch: ['#6a2bd4', '#2bd4c4', '#d42b8a'] },
  { id: 'kirby', name: 'Kirby', swatch: ['#ffdcec', '#ff7fb6', '#fff2f7'] },
  { id: 'gorbino', name: 'Gorbino', swatch: ['#3a2d10', '#39ff14', '#ff00d4'] },
];

const META_COLORS = {
  dark: '#111318', light: '#eef1f6', oled: '#000000',
  rgb: '#0d0d12', kirby: '#ffdcec', gorbino: '#3a2d10',
};

let rgbRaf = null;

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

export function applyTheme(id) {
  document.documentElement.setAttribute('data-theme', id);
  store.set('theme', id);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && META_COLORS[id]) meta.setAttribute('content', META_COLORS[id]);
  updateRgbLoop();
}

function reduceMotion() {
  return document.documentElement.getAttribute('data-reduce-motion') === '1'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Start or stop the gentle RGB hue animation depending on theme + motion. */
export function updateRgbLoop() {
  const active = currentTheme() === 'rgb';
  if (rgbRaf) { cancelAnimationFrame(rgbRaf); rgbRaf = null; }
  if (!active) return;
  if (reduceMotion()) {
    document.documentElement.style.setProperty('--rgb-hue', '280');
    return;
  }
  let hue = 280;
  let last = performance.now();
  const loop = (now) => {
    const dt = now - last; last = now;
    hue = (hue + dt * 0.012) % 360; // ~30s per full cycle, gentle
    document.documentElement.style.setProperty('--rgb-hue', hue.toFixed(1));
    rgbRaf = requestAnimationFrame(loop);
  };
  rgbRaf = requestAnimationFrame(loop);
}

export function setScale(scale) {
  const v = String(scale);
  document.documentElement.style.setProperty('--scale', v);
  store.set('scale', v);
}

export function getScale() {
  return parseFloat(store.get('scale', '1')) || 1;
}

export function setReduceMotion(on) {
  if (on) document.documentElement.setAttribute('data-reduce-motion', '1');
  else document.documentElement.removeAttribute('data-reduce-motion');
  store.set('reduceMotion', on ? '1' : '0');
  updateRgbLoop();
}

export function reduceMotionEnabled() {
  return store.get('reduceMotion', '0') === '1';
}
