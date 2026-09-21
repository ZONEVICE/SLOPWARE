/**
 * Fallback for an unknown URL.
 */
import { el, icon } from '../core/dom.js';

export function notFoundView({ outlet }) {
  outlet.appendChild(
    el(
      'div',
      { class: 'page' },
      el(
        'div',
        { class: 'page-inner' },
        el(
          'div',
          { class: 'empty' },
          icon('chat', 'empty-icon'),
          el('div', { class: 'empty-title', text: 'Nothing here' }),
          el('p', { text: 'That page does not exist.' }),
          el('a', { class: 'btn btn-primary', href: '/', text: 'Go to the rooms' }),
        ),
      ),
    ),
  );
  return {};
}
