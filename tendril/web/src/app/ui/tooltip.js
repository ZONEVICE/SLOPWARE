/**
 * Tooltips for every element with a `data-tip` attribute: one floating
 * element shared by the whole page, shown after a short hover delay (never on
 * touch, where hover does not exist). Shortcuts can be appended with
 * `data-keys`.
 */
import { h } from '../core/dom.js';

const DELAY = 450;

export function installTooltips() {
  const tip = h('div.tooltip', { role: 'tooltip' });
  document.body.append(tip);
  let timer = null;
  let current = null;

  const hide = () => {
    clearTimeout(timer);
    tip.classList.remove('visible');
    current = null;
  };

  const show = (target) => {
    const text = target.getAttribute('data-tip');
    if (!text || !target.isConnected) return;
    const keys = target.getAttribute('data-keys');
    tip.textContent = text;
    if (keys) tip.append(h('span.tooltip-keys', { text: keys }));
    tip.classList.add('visible');
    const rect = target.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - tipRect.width - 6));
    let top = rect.bottom + 6;
    if (top + tipRect.height > window.innerHeight - 6) top = rect.top - tipRect.height - 6;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  };

  document.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return;
    const target = event.target instanceof Element ? event.target.closest('[data-tip]') : null;
    if (target === current) return;
    hide();
    if (!target) return;
    current = target;
    timer = setTimeout(() => show(target), DELAY);
  });
  document.addEventListener('pointerout', (event) => {
    if (current && !current.contains(event.relatedTarget)) hide();
  });
  for (const type of ['pointerdown', 'keydown', 'wheel', 'blur']) window.addEventListener(type, hide, true);
}
