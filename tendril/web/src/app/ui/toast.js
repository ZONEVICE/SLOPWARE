/**
 * Notifications in the lower-right corner. Each returns a handle with
 * `close()`; `sticky` ones stay until closed; actions are buttons.
 */
import { h, iconButton } from '../core/dom.js';
import { icon } from '../core/icons.js';

export function createToasts() {
  const host = h('div.toasts', { 'aria-live': 'polite' });
  document.body.append(host);

  function show(kind, message, { actions = [], sticky = false, timeout } = {}) {
    const close = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 180);
    };
    const iconName = { error: 'error', warn: 'warning', success: 'check', info: 'info' }[kind] || 'info';
    const el = h(
      'div.toast',
      { class: `toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      icon(iconName, 'toast-icon'),
      h('div.toast-body', {}, h('div.toast-message', { text: message }),
        actions.length
          ? h('div.toast-actions', {}, actions.map((a) =>
            h('button.btn.small', { type: 'button', class: a.primary ? 'primary' : '', text: a.label, onclick: () => { a.run?.(); close(); } })))
          : null),
      iconButton('close', 'Dismiss', close, { class: 'toast-close' }),
    );
    host.append(el);
    while (host.children.length > 5) host.firstElementChild.remove();
    if (!sticky) setTimeout(close, timeout ?? (kind === 'error' ? 8000 : 4000));
    return { close, el };
  }

  return {
    info: (msg, opts) => show('info', msg, opts),
    success: (msg, opts) => show('success', msg, opts),
    warn: (msg, opts) => show('warn', msg, opts),
    error: (msg, opts) => show('error', msg, opts),
  };
}
