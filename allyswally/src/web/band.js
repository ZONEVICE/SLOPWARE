// The shortcut band: a horizontally scrollable strip of pinned MASKED items,
// shown above the Mouse and Keyboard tabs. A tap runs the item over the socket.

import { $, el, haptic } from './util.js';

export function initBand(_app) {
  // The band container is static in index.html; nothing to build up front.
}

export function renderBand(app, items) {
  const band = $('#band');
  band.innerHTML = '';
  (items || []).forEach(item => {
    const dot = el('span', { class: 'dot' });
    if (item.color) dot.style.background = item.color;
    else dot.style.background = categoryColor(item.category);
    const btn = el('button', {
      class: 'band-item',
      title: item.description || item.name,
      'aria-label': `Run ${item.name}`,
      onclick: () => {
        haptic(12);
        app.send({ type: 'run', category: item.category, id: item.id });
      },
    }, [dot, document.createTextNode(item.name || '(unnamed)')]);
    band.appendChild(btn);
  });
}

function categoryColor(category) {
  switch (category) {
    case 'shortcuts': return 'var(--accent)';
    case 'launchers': return 'var(--ok)';
    case 'clipboard': return 'var(--warn)';
    case 'scripts': return 'var(--danger)';
    default: return 'var(--text-dim)';
  }
}
