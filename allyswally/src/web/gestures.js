// The gesture guide: a brief illustrated overlay explaining the trackpad
// gestures and the shortcut band. Shown automatically on first entry and
// reopenable from Settings → About. Illustrations are inline SVG, themed.

import { $, el } from './util.js';

const ITEMS = [
  {
    title: 'Drag to move',
    text: 'Slide one finger on the trackpad to move the pointer.',
    svg: `<circle cx="28" cy="28" r="24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.3"/>
          <circle cx="20" cy="20" r="5" fill="currentColor"/>
          <path d="M22 22 L40 40" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
          <path d="M40 40 l-7 1 M40 40 l-1 -7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/>`,
  },
  {
    title: 'Tap to click',
    text: 'A quick tap is a left click. Double-tap for a double click.',
    svg: `<circle cx="28" cy="28" r="24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.3"/>
          <circle cx="28" cy="28" r="7" fill="currentColor"/>
          <circle cx="28" cy="28" r="14" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5"/>`,
  },
  {
    title: 'Two fingers to scroll',
    text: 'Drag with two fingers to scroll, like a laptop trackpad.',
    svg: `<circle cx="22" cy="18" r="4" fill="currentColor"/>
          <circle cx="34" cy="18" r="4" fill="currentColor"/>
          <path d="M22 24 L22 40 M34 24 L34 40" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
          <path d="M18 36 l4 5 l4 -5 M30 36 l4 5 l4 -5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    title: 'Hold then drag',
    text: 'Press and hold, then move, to drag — or use the Drag lock button.',
    svg: `<circle cx="20" cy="22" r="5" fill="currentColor"/>
          <circle cx="20" cy="22" r="11" fill="none" stroke="currentColor" stroke-width="2" opacity="0.4"/>
          <path d="M24 26 L42 44" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>`,
  },
  {
    title: 'Shortcut band',
    text: 'The strip at the top runs your pinned commands with one tap. Pin items in Masked.',
    svg: `<rect x="6" y="20" width="14" height="16" rx="4" fill="currentColor"/>
          <rect x="24" y="20" width="14" height="16" rx="4" fill="currentColor" opacity="0.6"/>
          <rect x="42" y="20" width="10" height="16" rx="4" fill="currentColor" opacity="0.3"/>`,
  },
];

export function showGuide(force) {
  const overlay = $('#gestures');
  overlay.innerHTML = '';
  const card = el('div', { class: 'guide-card' });
  card.appendChild(el('h2', { text: 'Quick gesture guide' }));
  ITEMS.forEach(item => {
    const svg = el('div', { html: `<svg viewBox="0 0 56 56" width="56" height="56" style="color:var(--accent)">${item.svg}</svg>` }).firstChild;
    card.appendChild(el('div', { class: 'guide-item' }, [
      svg,
      el('div', { class: 'g-text' }, [el('strong', { text: item.title }), el('span', { text: item.text })]),
    ]));
  });
  card.appendChild(el('div', { class: 'modal-actions' }, [
    el('button', { class: 'btn btn-primary', text: 'Got it', onclick: () => { overlay.hidden = true; overlay.innerHTML = ''; } }),
  ]));
  overlay.appendChild(card);
  overlay.hidden = false;
}
