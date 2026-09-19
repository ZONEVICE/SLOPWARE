/**
 * Configuration is a value object shared by the API, persistence, and UI.
 * Keep validation here rather than teaching each feature its own defaults.
 * Chats and jobs take snapshots; editing defaults never mutates existing work.
 */
export const DEFAULT_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:11434',
  model: 'hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0',
  numCtx: 4096,
  numPredict: 2048,
  systemPrompt: 'You are a helpful assistant.',
  think: false,
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  repeatPenalty: 1.1,
  seed: -1,
  keepAlive: '5m',
  timeoutSeconds: 300,
  format: 'text',
  stop: Object.freeze([]),
});

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG));

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

function numberInRange(value, name, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)
      || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  }
  return value;
}

/** Validate a partial configuration, fill defaults, and return a fresh object. */
export function validateConfig(raw) {
  requireObject(raw, 'Configuration');
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`Unknown configuration field: ${key}.`);
  }
  const config = { ...DEFAULT_CONFIG, ...raw };
  if (typeof config.serverUrl !== 'string') throw new Error('Server URL must be text.');
  let url;
  try { url = new URL(config.serverUrl.trim()); }
  catch { throw new Error('Server URL must be an absolute HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash) {
    throw new Error('Server URL must use HTTP or HTTPS without credentials, query parameters, or a fragment.');
  }
  config.serverUrl = url.href.replace(/\/+$/, '');
  if (typeof config.model !== 'string' || !config.model.trim() || config.model.length > 512) {
    throw new Error('Model must be a nonempty name of at most 512 characters.');
  }
  config.model = config.model.trim();
  config.numCtx = numberInRange(config.numCtx, 'Context length', 128, 2097152, true);
  // Ollama supports -1 for unlimited generation and -2 to fill the context.
  config.numPredict = numberInRange(config.numPredict, 'Prediction limit', -2, 2097152, true);
  config.temperature = numberInRange(config.temperature, 'Temperature', 0, 5);
  config.topP = numberInRange(config.topP, 'Top P', 0, 1);
  config.topK = numberInRange(config.topK, 'Top K', 0, 10000, true);
  config.repeatPenalty = numberInRange(config.repeatPenalty, 'Repeat penalty', 0, 10);
  config.seed = numberInRange(config.seed, 'Seed', -1, 2147483647, true);
  config.timeoutSeconds = numberInRange(config.timeoutSeconds, 'Request timeout', 1, 86400, true);
  if (typeof config.systemPrompt !== 'string' || config.systemPrompt.length > 1000000) {
    throw new Error('System prompt must be text of at most 1,000,000 characters.');
  }
  if (typeof config.think !== 'boolean') throw new Error('Think must be true or false.');
  if (!['text', 'json'].includes(config.format)) throw new Error('Response format must be text or json.');
  if (typeof config.keepAlive !== 'string'
      || !/^(?:-1|0|(?:\d+(?:\.\d+)?)(?:ms|s|m|h))$/.test(config.keepAlive)) {
    throw new Error('Keep alive must be -1, 0, or a duration such as 30s, 5m, or 1h.');
  }
  if (!Array.isArray(config.stop) || config.stop.length > 64
      || config.stop.some(item => typeof item !== 'string' || !item.length || item.length > 4096)) {
    throw new Error('Stop sequences must be an array of up to 64 nonempty strings.');
  }
  config.stop = [...config.stop];
  return config;
}

/** Frozen snapshots make per-chat configuration inheritance explicit. */
export function configSnapshot(raw) {
  const config = validateConfig(raw);
  Object.freeze(config.stop);
  return Object.freeze(config);
}

/** Accept our versioned export or a plain config object for manual workflows. */
export function parseConfigImport(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); }
    catch { throw new Error('The configuration file is not valid JSON.'); }
  }
  requireObject(data, 'Imported configuration');
  if (Object.hasOwn(data, 'config')) {
    const allowed = new Set(['schema', 'version', 'exportedAt', 'config']);
    if (Object.keys(data).some(key => !allowed.has(key))) throw new Error('Unknown configuration export field.');
    if (data.schema !== 'guanaco.configuration' || data.version !== 1) {
      throw new Error('Unsupported configuration export format or version.');
    }
    return validateConfig(data.config);
  }
  return validateConfig(data);
}

export function exportConfig(config) {
  return JSON.stringify({
    schema: 'guanaco.configuration',
    version: 1,
    exportedAt: new Date().toISOString(),
    config: validateConfig(config),
  }, null, 2);
}
