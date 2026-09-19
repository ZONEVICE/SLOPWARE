import { validateConfig } from '../core/config.js';
import { el, button } from './dom.js';

/** Shared schema-backed editor: both global and per-chat settings use this form. */
export function createConfigForm(initial, { getModels, onSubmit, submitLabel = 'Save configuration', compact = false } = {}) {
  const form = el('form', { class: 'configuration-form' });
  const fields = {}, prefix = `config-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  const field = (name, label, help, { type = 'number', full = false, ...attrs } = {}) => {
    const control = el(type === 'textarea' ? 'textarea' : 'input', { id: `${prefix}-${name}`, name, ...(type === 'textarea' ? { rows: 4 } : { type }), ...attrs });
    if (type === 'checkbox') control.checked = Boolean(initial[name]);
    else control.value = name === 'stop' ? JSON.stringify(initial.stop, null, 2) : initial[name];
    fields[name] = control;
    const helpId = `${prefix}-${name}-help`;
    control.setAttribute('aria-describedby', helpId);
    return el('div', { class: `field${full ? ' full' : ''}${type === 'checkbox' ? ' switch-field' : ''}` }, el('label', { htmlFor: control.id, text: label }), control, el('span', { class: 'field-help', id: helpId, text: help }));
  };

  const modelSelect = el('select', { id: `${prefix}-model`, name: 'model', required: true });
  fields.model = modelSelect;
  const modelStatus = el('span', { class: 'field-help', 'aria-live': 'polite', text: 'Loading models from your server…' });
  function setOptions(models, selection) {
    const names = [...new Set(models.map(model => model.name || model.model).filter(Boolean))];
    modelSelect.replaceChildren();
    if (selection && !names.includes(selection)) modelSelect.append(el('option', { value: selection, text: `${selection} (saved selection)` }));
    if (!selection && !names.length) modelSelect.append(el('option', { value: '', text: 'Connect to load models' }));
    for (const name of names) modelSelect.append(el('option', { value: name, text: name }));
    modelSelect.value = selection || names[0] || '';
  }
  setOptions([], initial.model);
  let requestSequence = 0;
  async function refreshModels(force = true) {
    const sequence = ++requestSequence;
    refresh.disabled = true;
    modelStatus.textContent = 'Connecting to Ollama…';
    try {
      const config = validateConfig({ ...initial, serverUrl: fields.serverUrl.value });
      const models = await getModels(config, force);
      if (sequence !== requestSequence || !form.isConnected) return;
      setOptions(models, modelSelect.value);
      modelStatus.textContent = models.length ? `${models.length} available models. Select one for new requests.` : 'No models installed. Use ollama pull in your terminal.';
      modelStatus.className = 'field-help';
    } catch (error) {
      if (sequence !== requestSequence) return;
      modelStatus.textContent = error.message;
      modelStatus.className = 'field-help error-text';
    } finally { if (sequence === requestSequence) refresh.disabled = false; }
  }
  const refresh = button('↻ Refresh models', () => refreshModels(), 'button ghost small');
  const basics = el('div', { class: 'form-grid' },
    field('serverUrl', 'Ollama server URL', 'Use the server root, for example http://localhost:11434. Remote servers must allow this browser origin.', { type: 'url', full: true, required: true, placeholder: 'http://localhost:11434' }),
    el('div', { class: 'field full' }, el('label', { htmlFor: modelSelect.id, text: 'Model' }), el('div', { class: 'model-select-row' }, modelSelect, refresh), modelStatus),
    field('numCtx', 'Context window · num_ctx', 'Token budget for conversation context.', { min: 128, max: 2097152, step: 1, required: true }),
    field('numPredict', 'Response limit · num_predict', 'Maximum generated tokens. -1 means unlimited; -2 fills the context.', { min: -2, max: 2097152, step: 1, required: true }),
    field('systemPrompt', 'System prompt', 'Instructions included with every request in this chat.', { type: 'textarea', full: true, placeholder: 'You are a helpful assistant.' }),
    field('think', 'Enable Think mode', 'Stream model thinking separately. Requires a compatible model such as Qwen3. GPT-OSS uses thinking levels and cannot fully disable thinking.', { type: 'checkbox', full: true })
  );
  fields.serverUrl.addEventListener('change', () => refreshModels());
  const advanced = el('details', { class: 'advanced-settings' }, el('summary', { text: 'Advanced Configuration' }), el('p', { class: 'muted', text: 'Fine-tune generation and request behavior.' }));
  const grid = el('div', { class: 'form-grid' },
    field('temperature', 'Temperature', 'Higher values produce more varied responses.', { min: 0, max: 5, step: 'any', required: true }),
    field('topP', 'Top P', 'Cumulative probability cutoff for token sampling.', { min: 0, max: 1, step: 'any', required: true }),
    field('topK', 'Top K', 'Number of token candidates considered. 0 disables the limit.', { min: 0, max: 10000, step: 1, required: true }),
    field('repeatPenalty', 'Repeat penalty', '1 disables the penalty for repeated tokens.', { min: 0, max: 10, step: 'any', required: true }),
    field('seed', 'Random seed', '-1 uses random sampling; set an integer for repeatability.', { min: -1, max: 2147483647, step: 1, required: true }),
    field('keepAlive', 'Keep model loaded', 'Duration such as 5m or 1h. Use 0 to unload or -1 to keep loaded.', { type: 'text', required: true }),
    field('timeoutSeconds', 'Request timeout (seconds)', 'Abort a generation that exceeds this total time.', { min: 1, max: 86400, step: 1, required: true }),
    field('stop', 'Stop sequences (JSON)', 'Use a JSON array of exact strings, or [] for none. Escape line breaks as \\n.', { type: 'textarea', full: true, rows: 3 })
  );
  fields.format = el('select', { id: `${prefix}-format`, name: 'format' }, el('option', { value: 'text', text: 'Text' }), el('option', { value: 'json', text: 'JSON' }));
  fields.format.value = initial.format;
  grid.append(el('div', { class: 'field' }, el('label', { htmlFor: fields.format.id, text: 'Response format' }), fields.format, el('span', { class: 'field-help', text: 'For JSON output, also ask for JSON in your prompt.' })));
  advanced.append(grid);
  const errorBox = el('div', { class: 'notice error', hidden: true, role: 'alert' });
  const save = el('button', { type: 'submit', class: 'button primary', text: submitLabel });
  form.append(basics, advanced, errorBox, el('div', { class: 'form-actions' }, save));
  form.addEventListener('submit', async event => {
    event.preventDefault(); errorBox.hidden = true;
    try {
      const config = read();
      await onSubmit(config);
    } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
  });
  function read() {
    const raw = {};
    for (const [name, control] of Object.entries(fields)) {
      raw[name] = control.type === 'checkbox' ? control.checked : control.type === 'number' ? (control.value.trim() ? Number(control.value) : NaN) : control.value;
    }
    // JSON preserves whitespace and embedded newlines in imported stop strings.
    // A line-based editor would silently corrupt valid model delimiters.
    try { raw.stop = JSON.parse(fields.stop.value); }
    catch { throw new Error('Stop sequences must be a JSON array of strings, such as ["END"] or [].'); }
    return validateConfig(raw);
  }
  // Deferred until the caller attaches the editor to a view or dialog.
  setTimeout(() => refreshModels(false), 0);
  return { element: form, read, refreshModels, fields, destroy() { requestSequence++; } };
}
