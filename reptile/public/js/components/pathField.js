/**
 * An absolute-path input that validates itself while the user types.
 *
 * After each pause in typing it asks the server (`POST /api/paths/check`)
 * whether the path exists, is a directory, and can be read (to host) or
 * written (to sync into), and shows the answer under the input. Answers to
 * older keystrokes are discarded, so a slow check never overwrites a newer one.
 */
import { api } from '../core/api.js';
import { debounce, h, icon, replace } from '../core/dom.js';

/**
 * @param {object} options
 * @param {'host'|'sync'} options.purpose
 * @param {string} options.id
 * @param {string} [options.placeholder]
 * @param {(result: object|null) => void} [options.onResult] null while typing/pending.
 */
export function createPathField({ purpose, id, placeholder, onResult }) {
  const input = h('input', {
    id,
    class: 'input mono',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder,
  });
  const status = h('div', { class: 'check', 'aria-live': 'polite' });
  let sequence = 0;
  let result = null;

  const show = (kind, text) => {
    status.className = `check ${kind}`;
    replace(status, kind === 'ok' ? icon('check') : kind === 'error' ? icon('x') : null, h('span', { text }));
  };

  const run = async () => {
    const value = input.value.trim();
    const mine = ++sequence;
    if (!value) {
      result = null;
      show('', '');
      onResult?.(null);
      return;
    }
    show('pending', 'Checking…');
    try {
      const answer = await api.post('/api/paths/check', { path: value, purpose });
      if (mine !== sequence) return;
      result = answer;
      show(answer.ok ? 'ok' : 'error', answer.message);
      input.classList.toggle('invalid', !answer.ok);
      onResult?.(answer);
    } catch (error) {
      if (mine !== sequence) return;
      result = null;
      show('error', error.message);
      onResult?.(null);
    }
  };
  const scheduled = debounce(run, 280);

  input.addEventListener('input', () => {
    result = null;
    input.classList.remove('invalid');
    onResult?.(null);
    show('pending', 'Checking…');
    scheduled();
  });

  return {
    input,
    status,
    get value() {
      return input.value.trim();
    },
    /** Set the value programmatically and validate it. */
    set(value) {
      input.value = value;
      scheduled.cancel();
      run();
    },
    /** The last successful or failed answer for the current text, or null. */
    get result() {
      return result;
    },
    focus() {
      input.focus();
    },
    destroy() {
      scheduled.cancel();
      sequence += 1;
    },
  };
}
