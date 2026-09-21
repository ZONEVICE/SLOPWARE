/**
 * "Choose your username" prompt.
 *
 * This is THE ONLY step a client has to complete before using the chat. It
 * appears when a session has no username yet, and it is not dismissible when
 * the client arrived through a direct room link, because there is nothing
 * useful to show behind it in that case.
 *
 * The random colour is assigned by the server the moment the name is accepted;
 * the client never picks it.
 */
import { el } from '../core/dom.js';
import { openModal } from './modal.js';
import { updateProfile } from '../core/profile.js';
import { state, isIdentified } from '../core/state.js';

let openPrompt = null;

/**
 * Ask for a username.
 *
 * @param {{ mandatory?: boolean, reason?: string, onCancel?: () => void }} [options]
 * @returns {Promise<boolean>} true once a username is set, false if cancelled.
 */
export function promptForIdentity(options = {}) {
  // Never stack two prompts; reuse the one already on screen.
  if (openPrompt) return openPrompt.promise;

  const promise = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      openPrompt = null;
      resolve(value);
    };

    const error = el('div', { class: 'field-error', role: 'alert' });
    const input = el('input', {
      class: 'input',
      type: 'text',
      name: 'displayName',
      placeholder: 'e.g. Mora, Jun, or anything you like',
      autocomplete: 'nickname',
      maxlength: String(state.limits.maxDisplayNameLength || 120),
      // Mobile keyboards should not capitalise or autocorrect a nickname.
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      required: true,
    });

    const submitButton = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Join the chat' });

    const form = el(
      'form',
      {
        class: 'stack',
        onSubmit: async (event) => {
          event.preventDefault();
          const value = input.value.trim();
          if (!value) {
            error.textContent = 'Pick any name to continue.';
            input.focus();
            return;
          }

          submitButton.disabled = true;
          error.textContent = '';
          try {
            await updateProfile({ displayName: value });
            finish(true);
            modal.close();
          } catch (failure) {
            error.textContent = failure.message || 'Could not set that username.';
            submitButton.disabled = false;
            input.focus();
          }
        },
      },
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field-label', for: 'displayName', text: 'Username' }),
        input,
        el('p', {
          class: 'field-hint',
          text: 'Anything goes - no rules, no registration. A colour is picked for you automatically.',
        }),
      ),
      error,
      el('div', { class: 'modal-actions' }, submitButton),
    );

    const modal = openModal({
      title: 'Pick a username',
      description: options.reason || 'One step, and you are in. Nothing else is required.',
      dismissible: !options.mandatory,
      content: form,
      onClose: () => {
        if (!isIdentified()) {
          if (options.onCancel) options.onCancel();
          finish(false);
        }
      },
    });
  });

  openPrompt = { promise };
  return promise;
}

/** True when a prompt is currently on screen. */
export function isIdentityPromptOpen() {
  return openPrompt !== null;
}
