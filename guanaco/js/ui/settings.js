import { DEFAULT_CONFIG, exportConfig, parseConfigImport, validateConfig } from '../core/config.js';
import { looksLikeOpenRouterKey, maskApiKey } from '../core/credentials.js';
import { keyInfo, describeKey, OPENROUTER_LINKS } from '../core/openrouter.js';
import { createConfigForm } from './config-form.js';
import { createThemePicker } from './theme.js';
import { el, button, downloadJson } from './dom.js';

export function createSettingsView(context) {
  const { store, toast, getModels, checkConnection, confirm, theme, credentials } = context;
  // Appearance applies immediately and is stored apart from global defaults.
  const themePicker = createThemePicker(theme, { labelledBy: 'appearance-title', onSaveError: () => toast('Theme applied, but this browser could not save it for next time.', true) });
  const root = el('div');
  const editorHost = el('div');
  const connection = el('div', { class: 'connection-result', role: 'status', text: 'Test your server connection or refresh the model list below.' });
  let editor;
  const importInput = document.querySelector('#import-file');
  async function importFile() {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      if (file.size > 2000000) throw new Error('Configuration files must be smaller than 2 MB.');
      const config = parseConfigImport(await file.text());
      store.setConfig(config); mountEditor(); toast('Configuration imported. New chats will use these defaults.'); checkConnection(config);
    } catch (error) { toast(error.message, true); }
    finally { importInput.value = ''; }
  }
  importInput.addEventListener('change', importFile);
  const test = button('↗ Test connection', async () => {
    test.disabled = true; connection.textContent = 'Connecting…'; connection.className = 'connection-result';
    try {
      // Only the provider and Ollama's URL matter here; the rest of the form
      // may still be incomplete (for example, no OpenRouter model chosen yet).
      const provider = editor.fields.provider.value;
      const config = validateConfig(provider === 'openrouter' ? { provider } : { serverUrl: editor.fields.serverUrl.value });
      const result = await checkConnection(config);
      if (!result.ok) throw new Error(result.error);
      if (result.provider === 'openrouter' && !result.account) {
        connection.textContent = `OpenRouter is reachable · ${result.models.length} models. No API key is saved yet: add one in the OpenRouter API key section to send requests.`;
        connection.className = 'connection-result warning-text';
      } else {
        connection.textContent = result.provider === 'openrouter'
          ? `Connected to OpenRouter · ${result.models.length} models · ${describeKey(result.account)}`
          : `Connected · Ollama ${result.version || 'server'} · ${result.models.length} available models`;
        connection.className = 'connection-result success-text';
      }
      editor.refreshModels(false);
    } catch (error) { connection.textContent = error.message; connection.className = 'connection-result error-text'; }
    finally { test.disabled = false; }
  }, 'button secondary small');

  // OpenRouter API key: a browser-level secret, saved apart from the
  // configuration (see core/credentials.js), so it is never exported.
  const keyInput = el('input', { id: 'openrouter-key', type: 'password', name: 'openrouterKey', autocomplete: 'off', spellcheck: false, placeholder: 'sk-or-v1-…', 'aria-describedby': 'openrouter-key-help' });
  const reveal = button('Show', () => { const hidden = keyInput.type === 'password'; keyInput.type = hidden ? 'text' : 'password'; reveal.textContent = hidden ? 'Hide' : 'Show'; reveal.setAttribute('aria-pressed', String(hidden)); }, 'button ghost small', { 'aria-pressed': 'false', 'aria-controls': 'openrouter-key' });
  const remember = el('input', { id: 'openrouter-remember', type: 'checkbox', 'aria-describedby': 'openrouter-remember-help' });
  const keyState = el('span', { class: 'muted' });
  const keyResult = el('div', { class: 'connection-result', role: 'status' });
  const checkKey = button('Check key', () => verifyKey(), 'button secondary small');
  const forgetKey = button('Forget key', () => {
    credentials.clearOpenRouterKey(); keyInput.value = ''; updateKeyState(true);
    keyResult.textContent = 'Key removed from this browser.'; keyResult.className = 'connection-result';
    afterKeyChange();
  }, 'button ghost small');
  const keyForm = el('form', { class: 'key-form' },
    el('div', { class: 'field' }, el('label', { htmlFor: keyInput.id, text: 'API key' }), el('div', { class: 'model-select-row' }, keyInput, reveal),
      el('span', { class: 'field-help', id: 'openrouter-key-help' }, 'Create one at ', el('a', { href: OPENROUTER_LINKS.keys, target: '_blank', rel: 'noopener', text: 'openrouter.ai/settings/keys ↗' }), '. A credit limit on the key caps what a leaked key could spend.')),
    el('div', { class: 'field switch-field' }, el('label', { htmlFor: remember.id, text: 'Remember on this device' }), remember, el('span', { class: 'field-help', id: 'openrouter-remember-help', text: 'Off: the key is forgotten when this tab closes. On: it is kept in this browser’s local storage, unencrypted, until you forget it.' })),
    el('div', { class: 'form-actions' }, el('button', { type: 'submit', class: 'button primary', text: 'Save key' }), checkKey, forgetKey));
  keyForm.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const where = credentials.setOpenRouterKey(keyInput.value, remember.checked);
      const saved = credentials.openRouterKey;
      keyInput.value = ''; keyInput.type = 'password'; reveal.textContent = 'Show';
      updateKeyState(true);
      if (where === 'memory') toast('This browser refused to store the key; it will be forgotten when this page reloads.', true);
      afterKeyChange();
      verifyKey(looksLikeOpenRouterKey(saved) ? '' : 'This does not look like an OpenRouter key (they start with sk-or-). Keys from OpenAI, Anthropic, or other vendors do not work here. ');
    } catch (error) { keyResult.textContent = error.message; keyResult.className = 'connection-result error-text'; }
  });
  async function verifyKey(prefix = '') {
    const key = credentials.openRouterKey;
    if (!key) { keyResult.textContent = 'No key is saved yet.'; keyResult.className = 'connection-result warning-text'; return; }
    checkKey.disabled = true; keyResult.textContent = `${prefix}Checking the key with OpenRouter…`; keyResult.className = 'connection-result';
    try {
      keyResult.textContent = `${prefix}${describeKey(await keyInfo(key))}`;
      keyResult.className = `connection-result ${prefix ? 'warning-text' : 'success-text'}`;
    } catch (error) { keyResult.textContent = `${prefix}${error.message}`; keyResult.className = 'connection-result error-text'; }
    finally { checkKey.disabled = false; }
  }
  // syncRemember is false on routine view updates, which must not undo a
  // checkbox the user has ticked but not saved yet.
  function updateKeyState(syncRemember = false) {
    const key = credentials.openRouterKey, where = credentials.persistence;
    keyState.textContent = key ? `${maskApiKey(key)} · ${({ device: 'remembered on this device', session: 'this tab only', memory: 'until reload' })[where]}` : 'Not set';
    if (syncRemember) remember.checked = where === 'device';
    forgetKey.disabled = !key;
  }
  function afterKeyChange() {
    editor?.updateKeyNotice();
    if (store.state.config.provider === 'openrouter') checkConnection();
  }
  updateKeyState(true);
  root.append(
    el('header', { class: 'view-header' }, el('div', {}, el('p', { class: 'eyebrow', text: 'MAKE IT YOURS' }), el('h1', { text: 'Configuration' }), el('p', { class: 'subtitle', text: 'Set the starting point for every new conversation.' })), el('div', { class: 'actions' }, button('↓ Export JSON', () => { downloadJson(exportConfig(store.state.config), 'guanaco-configuration.json'); toast('Saved global configuration exported.'); }, 'button secondary'), button('↑ Import JSON', () => importInput.click(), 'button secondary'))),
    el('div', { class: 'settings-layout' },
      el('div', { class: 'settings-main' },
        el('section', { class: 'settings-card', 'aria-labelledby': 'appearance-title' }, el('div', { class: 'section-heading' }, el('h2', { id: 'appearance-title', text: 'Appearance' }), el('span', { class: 'muted', text: 'Saved in this browser' })), themePicker.element),
        el('section', { class: 'settings-card' }, el('div', { class: 'section-heading' }, el('h2', { text: 'Global defaults' }), test), connection, editorHost),
        el('section', { class: 'settings-card', 'aria-labelledby': 'openrouter-key-title' }, el('div', { class: 'section-heading' }, el('h2', { id: 'openrouter-key-title', text: 'OpenRouter API key' }), keyState), el('p', { class: 'muted', text: 'Needed only for conversations whose provider is OpenRouter. Requests go straight from this browser to openrouter.ai. The key is never part of configuration exports or conversations.' }), keyForm, keyResult)),
      el('aside', { class: 'settings-intro' },
        el('div', { class: 'settings-note' }, el('span', { class: 'settings-note-icon', text: '↗' }), el('h3', { text: 'A starting point, per chat' }), el('p', { text: 'Every new conversation takes a snapshot of these defaults. Existing conversations and queued requests keep their own settings.' }), el('p', { text: 'Use the gear button on any request window to customize just that conversation.' }), el('div', { class: 'config-legend' }, el('span', { class: 'badge global', text: 'Global snapshot' }), el('span', { class: 'badge custom', text: 'Custom config' }))),
        el('div', { class: 'settings-note' }, el('h3', { text: 'Saved in this browser' }), el('p', { text: 'Your settings, theme, and conversations stay in local browser storage. Export your saved defaults as JSON to use them in another browser; the theme and the OpenRouter key are not exported.' }), el('p', { text: 'Keep one editing tab open to avoid competing workspace saves.' })),
        el('div', { class: 'settings-note' }, el('h3', { text: 'Connecting a remote server?' }), el('p', { text: 'Ollama must allow this page’s origin through OLLAMA_ORIGINS. An HTTPS page needs an HTTPS Ollama endpoint.' }), el('a', { href: './docs/ollama.md', target: '_blank', rel: 'noopener', text: 'Read the Ollama setup guide ↗' })),
        el('div', { class: 'settings-note' }, el('h3', { text: 'Using OpenRouter?' }), el('p', { text: 'Choose OpenRouter as the provider, globally or for one conversation, and save an API key. Prompts and history then go to OpenRouter and to the company hosting the model.' }), el('p', { text: 'Free models (ids ending in :free) are rate-limited to 20 requests per minute and 50 per day without purchased credits.' }), el('a', { href: './docs/openrouter.md', target: '_blank', rel: 'noopener', text: 'Read the OpenRouter guide ↗' })),
        button('Restore default settings', async () => {
          if (await confirm('Restore default settings?', 'Your saved global configuration will be replaced with Guanaco defaults. Existing conversations retain their settings, and the theme does not change.', 'Restore defaults')) {
            store.setConfig(DEFAULT_CONFIG); mountEditor(); toast('Default settings restored.'); checkConnection(DEFAULT_CONFIG);
          }
        }, 'button ghost')
      )
    )
  );
  function mountEditor() {
    editor?.destroy();
    editor = createConfigForm(store.state.config, { getModels, credentials, submitLabel: 'Save global configuration', onSubmit: config => { store.setConfig(config); toast('Global configuration saved. Applies to new conversations.'); checkConnection(config); } });
    editorHost.replaceChildren(editor.element);
  }
  mountEditor();
  return { element: root, update() { themePicker.update(); updateKeyState(); editor?.updateKeyNotice(); }, destroy() { editor.destroy(); importInput.removeEventListener('change', importFile); } };
}
