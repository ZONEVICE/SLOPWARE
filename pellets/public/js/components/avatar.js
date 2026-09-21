/**
 * User avatar: initials tinted with the user's own hue.
 *
 * There are no uploaded profile pictures in Pellets; the hue assigned when a
 * client picks a username is the whole identity system, so it is applied
 * consistently here, in message headers and in the member list.
 */
import { el, applyHue } from '../core/dom.js';
import { initials } from '../core/format.js';

/**
 * @param {{ displayName?: string|null, colorHue?: number|null }} user
 * @param {{ size?: 'sm'|'md'|'lg', title?: string }} [options]
 */
export function avatar(user, options = {}) {
  const sizeClass = options.size === 'sm' ? ' avatar-sm' : options.size === 'lg' ? ' avatar-lg' : '';
  const node = el('div', {
    class: `avatar${sizeClass}`,
    'aria-hidden': 'true',
    title: options.title || user?.displayName || '',
    text: initials(user?.displayName),
  });
  return applyHue(node, user?.colorHue);
}
