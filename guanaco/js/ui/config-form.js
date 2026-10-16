import { validateConfig } from '../core/config.js';
import { el, button } from './dom.js';

/**
 * Wording that differs per provider. Fields listed in `hidden` do not apply to
 * that provider: they are hidden and disabled (so the browser does not
 * validate them) but still read, so switching back restores their values.
 */
const PROVIDER_TEXT = {
  ollama: {
    hidden: [],
    providerHelp: 'Your own Ollama server, local or remote. Conversations go only to that server.',
    numPredict: ['Response limit · num_predict', 'Maximum generated tokens. -1 means unlimited; -2 fills the context.'],
    think: 'Stream model thinking separately. Requires a compatible model such as Qwen3. GPT-OSS uses thinking levels and cannot fully disable thinking.',
    temperature: 'Higher values produce more varied responses.',
    connecting: 'Connecting to Ollama…',
    none: 'No models installed. Use ollama pull in your terminal.',
  },
  openrouter: {
    hidden: ['serverUrl', 'numCtx', 'keepAlive'],
    providerHelp: 'OpenRouter’s cloud API at openrouter.ai, with hundreds of hosted models. Conversations leave this computer: OpenRouter and the model’s provider receive them. Uses the API key saved in Configuration.',
    numPredict: ['Response limit · max_tokens', 'Maximum generated tokens, reasoning included. OpenRouter reserves credit for this amount before it starts. -1 or -2 leave the limit to the model.'],
    think: 'Ask the model to reason first and stream its reasoning separately. When off, Guanaco turns reasoning off where the model allows it; some models always reason.',
    temperature: 'Higher values produce more varied responses. OpenRouter accepts 0 to 2.',
    connecting: 'Loading the OpenRouter model catalogue…',
    none: 'OpenRouter returned no chat models.',
  },
};

/** Shared schema-backed editor: both global and per-chat settings use this form. */
export function createConfigForm(initial, { getModels, credentials, onSubmit, submitLabel = 'Save configuration', compact = false } = {}) {
  const form = el('form', { class: 'configuration-form' });
  const fields = {}, parts = {}, prefix = `config-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  const field = (name, label, help, { type = 'number', full = false, ...attrs } = {}) => {
    const control = el(type === 'textarea' ? 'textarea' : 'input', { id: `${prefix}-${name}`, name, ...(type === 'textarea' ? { rows: 4 } : { type }), ...attrs });
    if (type === 'checkbox') control.checked = Boolean(initial[name]);
    else control.value = name === 'stop' ? JSON.stringify(initial.stop, null, 2) : initial[name];
    fields[name] = control;
    const helpId = `${prefix}-${name}-help`;
    control.setAttribute('aria-describedby', helpId);
    const labelNode = el('label', { htmlFor: control.id, text: label }), helpNode = el('span', { class: 'field-help', id: helpId, text: help });
    const wrapper = el('div', { class: `field${full ? ' full' : ''}${type === 'checkbox' ? ' switch-field' : ''}` }, labelNode, control, helpNode);
    parts[name] = { wrapper, label: labelNode, help: helpNode };
    return wrapper;
  };

  fields.provider = el('select', { id: `${prefix}-provider`, name: 'provider', 'aria-describedby': `${prefix}-provider-help` },
    el('option', { value: 'ollama', text: 'Ollama · your own server' }),
    el('option', { value: 'openrouter', text: 'OpenRouter · cloud API' }));
  fields.provider.value = initial.provider;
  const providerHelp = el('span', { class: 'field-help', id: `${prefix}-provider-help` });
  const keyNotice = el('div', { class: 'notice warning', role: 'note', hidden: true });

  const modelSelect = el('select', { id: `${prefix}-model`, name: 'model', required: true });
  fields.model = modelSelect;
  const modelStatus = el('span', { class: 'field-help', 'aria-live': 'polite', text: 'Loading models from your server…' });
  const modelDetail = el('span', { class: 'field-help', hidden: true });
  // OpenRouter lists hundreds of models; a filter keeps the dropdown usable.
  const modelFilter = el('input', { type: 'search', placeholder: 'Filter models, e.g. gemma or :free', 'aria-label': 'Filter models', autocomplete: 'off' });
  const freeOnly = el('input', { type: 'checkbox', id: `${prefix}-free-only` });
  const filterRow = el('div', { class: 'model-filter-row', hidden: true }, modelFilter, el('label', { class: 'inline-check', htmlFor: freeOnly.id }, freeOnly, 'Free only'));
  let loadedModels = [];
  // Each provider remembers its own model while the form is open, so trying
  // the other provider and switching back does not lose the selection.
  const remembered = { [initial.provider]: initial.model };
  const provider = () => fields.provider.value;
  const byName = name => loadedModels.find(model => model.name === name);

  function setOptions(models, selection) {
    loadedModels = models;
    const query = modelFilter.value.trim().toLowerCase();
    const visible = models.filter(model => (!freeOnly.checked || model.free)
      && (!query || `${model.name} ${model.displayName || ''}`.toLowerCase().includes(query)));
    const names = [...new Set(visible.map(model => model.name || model.model).filter(Boolean))];
    const allNames = new Set(models.map(model => model.name || model.model));
    modelSelect.replaceChildren();
    if (selection && !names.includes(selection)) {
      modelSelect.append(el('option', { value: selection, text: allNames.has(selection) || !models.length ? `${byName(selection)?.label || selection} (saved selection)` : `${selection} (saved selection, not in the current list)` }));
    }
    // OpenRouter has no sensible first model: make the choice explicit.
    if (!selection && (provider() === 'openrouter' || !names.length)) modelSelect.append(el('option', { value: '', text: models.length ? 'Select a model…' : 'Connect to load models' }));
    for (const name of names) modelSelect.append(el('option', { value: name, text: byName(name)?.label || name }));
    modelSelect.value = selection || (provider() === 'openrouter' ? '' : names[0] || '');
    showModelDetail();
  }

  function showModelDetail() {
    const model = byName(modelSelect.value);
    modelDetail.hidden = !model || provider() !== 'openrouter';
    if (modelDetail.hidden) return;
    const reasoning = model.reasoning.mandatory ? 'always reasons' : model.reasoning.supported ? 'reasoning optional' : 'no reasoning';
    modelDetail.textContent = `${model.displayName} · ${model.contextLength ? `${model.contextLength.toLocaleString('en')}-token context` : 'context unknown'} · ${model.price} · ${reasoning}`;
  }

  let requestSequence = 0;
  async function refreshModels(force = true) {
    const sequence = ++requestSequence;
    refresh.disabled = true;
    modelStatus.textContent = PROVIDER_TEXT[provider()].connecting;
    modelStatus.className = 'field-help';
    try {
      // Listing needs only the provider (and Ollama's URL); other fields may
      // be mid-edit or invalid for the provider just selected.
      const config = validateConfig(provider() === 'openrouter' ? { provider: 'openrouter' } : { serverUrl: fields.serverUrl.value });
      const models = await getModels(config, force);
      if (sequence !== requestSequence || !form.isConnected) return;
      setOptions(models, modelSelect.value);
      const free = models.filter(model => model.free).length;
      modelStatus.textContent = !models.length ? PROVIDER_TEXT[provider()].none
        : provider() === 'openrouter' ? `${models.length} models available, ${free} of them free. Prices are per million tokens.`
          : `${models.length} available models. Select one for new requests.`;
    } catch (error) {
      if (sequence !== requestSequence) return;
      modelStatus.textContent = error.message;
      modelStatus.className = 'field-help error-text';
    } finally { if (sequence === requestSequence) refresh.disabled = false; }
  }

  function applyProvider() {
    const text = PROVIDER_TEXT[provider()];
    providerHelp.textContent = text.providerHelp;
    for (const [name, part] of Object.entries(parts)) {
      const hidden = text.hidden.includes(name);
      part.wrapper.hidden = hidden; fields[name].disabled = hidden;
    }
    [parts.numPredict.label.textContent, parts.numPredict.help.textContent] = text.numPredict;
    parts.think.help.textContent = text.think;
    parts.temperature.help.textContent = text.temperature;
    fields.temperature.max = provider() === 'openrouter' ? 2 : 5;
    fields.repeatPenalty.max = provider() === 'openrouter' ? 2 : 10;
    filterRow.hidden = provider() !== 'openrouter';
    updateKeyNotice();
  }

  function updateKeyNotice() {
    const missing = provider() === 'openrouter' && credentials && !credentials.openRouterKey;
    keyNotice.hidden = !missing;
    keyNotice.textContent = missing ? 'No OpenRouter API key is saved in this browser yet. Add one under Configuration → OpenRouter API key; requests fail until then.' : '';
  }

  const refresh = button('↻ Refresh models', () => refreshModels(), 'button ghost small');
  const basics = el('div', { class: 'form-grid' },
    el('div', { class: 'field full' }, el('label', { htmlFor: fields.provider.id, text: 'Provider' }), fields.provider, providerHelp, keyNotice),
    field('serverUrl', 'Ollama server URL', 'Use the server root, for example http://localhost:11434. Remote servers must allow this browser origin.', { type: 'url', full: true, required: true, placeholder: 'http://localhost:11434' }),
    el('div', { class: 'field full' }, el('label', { htmlFor: modelSelect.id, text: 'Model' }), filterRow, el('div', { class: 'model-select-row' }, modelSelect, refresh), modelDetail, modelStatus),
    field('numCtx', 'Context window · num_ctx', 'Token budget for conversation context.', { min: 128, max: 2097152, step: 1, required: true }),
    field('numPredict', 'Response limit · num_predict', '', { min: -2, max: 2097152, step: 1, required: true }),
    field('systemPrompt', 'System prompt', 'Instructions included with every request in this chat.', { type: 'textarea', full: true, placeholder: 'You are a helpful assistant.' }),
    field('think', 'Enable Think mode', '', { type: 'checkbox', full: true })
  );
  fields.serverUrl.addEventListener('change', () => refreshModels());
  fields.provider.addEventListener('change', () => {
    const previous = fields.provider.dataset.previous || initial.provider;
    remembered[previous] = modelSelect.value;
    fields.provider.dataset.previous = provider();
    modelFilter.value = ''; freeOnly.checked = false;
    applyProvider();
    setOptions([], remembered[provider()] || '');
    refreshModels(false);
  });
  modelSelect.addEventListener('change', showModelDetail);
  modelFilter.addEventListener('input', () => setOptions(loadedModels, modelSelect.value));
  freeOnly.addEventListener('change', () => setOptions(loadedModels, modelSelect.value));
  setOptions([], initial.model);
  const advanced = el('details', { class: 'advanced-settings' }, el('summary', { text: 'Advanced Configuration' }), el('p', { class: 'muted', text: 'Fine-tune generation and request behavior.' }));
  const grid = el('div', { class: 'form-grid' },
    field('temperature', 'Temperature', '', { min: 0, max: 5, step: 'any', required: true }),
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
  applyProvider();
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
    if (!raw.model) throw new Error('Select a model first.');
    return validateConfig(raw);
  }
  // Deferred until the caller attaches the editor to a view or dialog.
  setTimeout(() => refreshModels(false), 0);
  return { element: form, read, refreshModels, updateKeyNotice, fields, destroy() { requestSequence++; } };
}
