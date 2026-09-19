import { DEFAULT_CONFIG, exportConfig, parseConfigImport } from '../core/config.js';
import { createConfigForm } from './config-form.js';
import { el, button, downloadJson } from './dom.js';

export function createSettingsView(context) {
  const { store, toast, getModels, checkConnection, confirm } = context;
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
      const config = editor.read();
      const result = await checkConnection(config);
      if (!result.ok) throw new Error(result.error);
      connection.textContent = `Connected · Ollama ${result.version || 'server'} · ${result.models.length} available models`;
      connection.className = 'connection-result success-text';
      editor.refreshModels(false);
    } catch (error) { connection.textContent = error.message; connection.className = 'connection-result error-text'; }
    finally { test.disabled = false; }
  }, 'button secondary small');
  root.append(
    el('header', { class: 'view-header' }, el('div', {}, el('p', { class: 'eyebrow', text: 'MAKE IT YOURS' }), el('h1', { text: 'Configuration' }), el('p', { class: 'subtitle', text: 'Set the starting point for every new conversation.' })), el('div', { class: 'actions' }, button('↓ Export JSON', () => { downloadJson(exportConfig(store.state.config), 'guanaco-configuration.json'); toast('Saved global configuration exported.'); }, 'button secondary'), button('↑ Import JSON', () => importInput.click(), 'button secondary'))),
    el('div', { class: 'settings-layout' },
      el('section', { class: 'settings-card' }, el('div', { class: 'section-heading' }, el('h2', { text: 'Global defaults' }), test), connection, editorHost),
      el('aside', { class: 'settings-intro' },
        el('div', { class: 'settings-note' }, el('span', { class: 'settings-note-icon', text: '↗' }), el('h3', { text: 'A starting point, per chat' }), el('p', { text: 'Every new conversation takes a snapshot of these defaults. Existing conversations and queued requests keep their own settings.' }), el('p', { text: 'Use the gear button on any request window to customize just that conversation.' }), el('div', { class: 'config-legend' }, el('span', { class: 'badge global', text: 'Global snapshot' }), el('span', { class: 'badge custom', text: 'Custom config' }))),
        el('div', { class: 'settings-note' }, el('h3', { text: 'Saved in this browser' }), el('p', { text: 'Your settings and conversations stay in local browser storage. Export your saved defaults as JSON to use them in another browser.' }), el('p', { text: 'Keep one editing tab open to avoid competing workspace saves.' })),
        el('div', { class: 'settings-note' }, el('h3', { text: 'Connecting a remote server?' }), el('p', { text: 'Ollama must allow this page’s origin through OLLAMA_ORIGINS. An HTTPS page needs an HTTPS Ollama endpoint.' }), el('a', { href: './docs/ollama.md', target: '_blank', rel: 'noopener', text: 'Read the Ollama setup guide ↗' })),
        button('Restore default settings', async () => {
          if (await confirm('Restore default settings?', 'Your saved global configuration will be replaced with Guanaco defaults. Existing conversations retain their settings.', 'Restore defaults')) {
            store.setConfig(DEFAULT_CONFIG); mountEditor(); toast('Default settings restored.'); checkConnection(DEFAULT_CONFIG);
          }
        }, 'button ghost')
      )
    )
  );
  function mountEditor() {
    editor?.destroy();
    editor = createConfigForm(store.state.config, { getModels, submitLabel: 'Save global configuration', onSubmit: config => { store.setConfig(config); toast('Global configuration saved. Applies to new conversations.'); checkConnection(config); } });
    editorHost.replaceChildren(editor.element);
  }
  mountEditor();
  return { element: root, update() {}, destroy() { editor.destroy(); importInput.removeEventListener('change', importFile); } };
}
