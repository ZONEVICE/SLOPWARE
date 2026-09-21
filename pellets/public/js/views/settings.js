/**
 * SETTINGS VIEW (window 3 of 3).
 *
 * Deliberately small: username, colour, theme. The UUID is shown but is
 * read-only - it is assigned once by the server and never changes, which is
 * exactly what the specification requires.
 */
import { el, icon, render, applyHue, disposer } from '../core/dom.js';
import { state, subscribe, isIdentified } from '../core/state.js';
import { updateProfile } from '../core/profile.js';
import { applyTheme, getTheme } from '../core/theme.js';
import { avatar } from '../components/avatar.js';
import { toast, toastError } from '../components/toast.js';
import { promptForIdentity } from '../components/identity.js';

/** The hues offered as swatches. Mirrors HUE_PALETTE in src/lib/colors.js. */
const HUES = [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 320, 340];

export function settingsView({ outlet }) {
  const off = disposer();

  const previewWrap = el('div', { class: 'row', style: { gap: '12px' } });
  const nameInput = el('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Your username',
    maxlength: String(state.limits.maxDisplayNameLength || 120),
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
  });
  const nameError = el('div', { class: 'field-error', role: 'alert' });
  const saveNameButton = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Save' });
  const swatches = el('div', { class: 'swatches' });
  const themeControl = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Colour theme' });
  const uuidNode = el('div', { class: 'mono' });

  // --- Identity card ---------------------------------------------------------

  const nameForm = el(
    'form',
    {
      class: 'row',
      style: { gap: '8px', alignItems: 'flex-start' },
      onSubmit: async (event) => {
        event.preventDefault();
        const value = nameInput.value.trim();
        if (!value) {
          nameError.textContent = 'Username cannot be empty.';
          return;
        }
        saveNameButton.disabled = true;
        nameError.textContent = '';
        try {
          await updateProfile({ displayName: value });
          toast('Username updated.', { tone: 'success' });
        } catch (error) {
          nameError.textContent = error.message || 'Could not save that username.';
        } finally {
          saveNameButton.disabled = false;
        }
      },
    },
    el('div', { class: 'grow' }, nameInput),
    saveNameButton,
  );

  // --- Colour ----------------------------------------------------------------

  function renderSwatches() {
    const current = state.session ? state.session.colorHue : null;
    render(
      swatches,
      HUES.map((hue) => {
        const button = el('button', {
          class: 'swatch',
          type: 'button',
          'aria-label': `Colour ${hue} degrees`,
          'aria-pressed': String(hue === current),
          onClick: async () => {
            try {
              await updateProfile({ colorHue: hue });
            } catch (error) {
              toastError(error);
            }
          },
        });
        return applyHue(button, hue);
      }),
    );
  }

  // --- Theme -----------------------------------------------------------------

  function renderTheme() {
    const current = getTheme();
    const option = (value, label, iconName) =>
      el(
        'button',
        {
          type: 'button',
          'aria-pressed': String(current === value),
          onClick: async () => {
            applyTheme(value);
            renderTheme();
            // Mirror the choice into the session so other tabs follow along.
            try {
              await updateProfile({ theme: value });
            } catch {
              // A failed sync is harmless: the local preference already applied.
            }
          },
        },
        icon(iconName),
        el('span', { text: label }),
      );

    render(themeControl, option('dark', 'Dark', 'moon'), option('light', 'Light', 'sun'));
  }

  // --- Preview ---------------------------------------------------------------

  function renderPreview() {
    const session = state.session;
    const name = session?.displayName || 'Not set yet';
    const row = el(
      'div',
      { class: 'row', style: { gap: '12px' } },
      avatar({ displayName: session?.displayName, colorHue: session?.colorHue }, { size: 'lg' }),
      el(
        'div',
        { class: 'stack', style: { gap: '2px' } },
        el('div', { style: { fontWeight: '640', fontSize: '1.05rem' }, text: name }),
        el('div', { class: 'setting-desc', text: 'This is how other people see you in every room.' }),
      ),
    );
    render(previewWrap, applyHue(row, session?.colorHue));
  }

  function syncFromSession() {
    const session = state.session;
    uuidNode.textContent = session ? session.id : '—';
    if (document.activeElement !== nameInput) nameInput.value = session?.displayName || '';
    renderPreview();
    renderSwatches();
  }

  // --- Layout ----------------------------------------------------------------

  const page = el(
    'div',
    { class: 'page page-narrow' },
    el(
      'div',
      { class: 'page-inner' },
      el(
        'div',
        { class: 'page-head' },
        el(
          'div',
          { class: 'page-title' },
          el('h1', { text: 'Settings' }),
          el('p', { class: 'page-subtitle', text: 'Your identity lives only in this server’s memory.' }),
        ),
      ),

      el('div', { class: 'card stack' }, previewWrap),

      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'setting-row' },
          el(
            'div',
            { class: 'grow' },
            el('div', { class: 'setting-label', text: 'Username' }),
            el('div', { class: 'setting-desc', text: 'Change it whenever you like. Anything is allowed.' }),
          ),
        ),
        el('div', { class: 'stack', style: { paddingBottom: '16px' } }, nameForm, nameError),

        el(
          'div',
          { class: 'setting-row' },
          el(
            'div',
            { class: 'grow' },
            el('div', { class: 'setting-label', text: 'Your colour' }),
            el('div', { class: 'setting-desc', text: 'Assigned at random when you joined. Pick another one below.' }),
          ),
        ),
        el('div', { style: { paddingBottom: '16px' } }, swatches),

        el(
          'div',
          { class: 'setting-row' },
          el(
            'div',
            { class: 'grow' },
            el('div', { class: 'setting-label', text: 'Appearance' }),
            el('div', { class: 'setting-desc', text: 'Dark is the default.' }),
          ),
          themeControl,
        ),

        el(
          'div',
          { class: 'setting-row' },
          el(
            'div',
            { class: 'grow' },
            el('div', { class: 'setting-label', text: 'Session ID' }),
            el('div', {
              class: 'setting-desc',
              text: 'A UUID v4 assigned by the server. It cannot be changed, and it is gone when the server restarts.',
            }),
            el('div', { style: { marginTop: '6px' } }, uuidNode),
          ),
        ),
      ),
    ),
  );

  outlet.appendChild(page);

  // --- Wiring ----------------------------------------------------------------

  off(subscribe('session', syncFromSession));
  renderTheme();
  syncFromSession();

  // Someone can land here before picking a name; offer the prompt once.
  if (!isIdentified()) {
    promptForIdentity({ reason: 'Pick a username to finish setting up your profile.' }).catch(() => {});
  }

  return {
    destroy() {
      off.dispose();
    },
  };
}
