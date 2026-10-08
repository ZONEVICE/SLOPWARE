/**
 * A four-digit PIN input. Anything that is not a digit is dropped as it is
 * typed, so pasting "12 34" still works.
 */
import { h } from '../core/dom.js';

/**
 * @param {{ value?: string, label?: string, onInput?: (value: string) => void, onEnter?: () => void }} [options]
 */
export function createPinInput({ value = '', label = 'PIN', onInput, onEnter } = {}) {
  const input = h('input', {
    class: 'pin-input',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: '4',
    pattern: '[0-9]{4}',
    placeholder: '••••',
    'aria-label': label,
    value,
  });
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 4);
    if (digits !== input.value) input.value = digits;
    input.classList.remove('invalid');
    onInput?.(digits);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onEnter?.();
    }
  });

  return {
    el: input,
    get value() {
      return input.value;
    },
    set value(next) {
      input.value = String(next ?? '').replace(/\D/g, '').slice(0, 4);
    },
    get valid() {
      return /^\d{4}$/.test(input.value);
    },
    markInvalid() {
      input.classList.add('invalid');
      input.focus();
      input.select();
    },
    focus() {
      input.focus();
    },
  };
}
