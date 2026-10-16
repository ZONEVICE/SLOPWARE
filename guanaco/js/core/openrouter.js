import { abortScope } from './http.js';

/**
 * The only module that knows OpenRouter's HTTP protocol: OpenAI-compatible
 * chat completions streamed as Server-Sent Events. Like api.js it has no DOM
 * or storage dependencies; the caller passes the API key with every call, so
 * the key never enters a configuration snapshot.
 *
 * OpenRouter answers browsers directly (CORS allows any origin), so no proxy
 * or local server is involved. Its failures are many and varied; every error
 * leaving this module says what happened, what to do, and OpenRouter's own
 * words, because the queue stores only error.message on the failed turn.
 * Reference: https://openrouter.ai/docs/api-reference/errors
 */

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';
export const OPENROUTER_LINKS = Object.freeze({
  keys: 'https://openrouter.ai/settings/keys',
  credits: 'https://openrouter.ai/settings/credits',
  privacy: 'https://openrouter.ai/settings/privacy',
  byok: 'https://openrouter.ai/settings/integrations',
  activity: 'https://openrouter.ai/activity',
  status: 'https://status.openrouter.ai',
});

const METADATA_TIMEOUT_SECONDS = 20;
const CATALOGUE_TTL_MS = 10 * 60 * 1000;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;

const clip = (text, limit) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
};
const money = value => (Number.isFinite(value) ? `$${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}` : '');
const localTime = value => {
  const date = new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
};

function rawText(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw === 'string') {
    // Providers often wrap a JSON error in a string; show its message only.
    try { const parsed = JSON.parse(raw); return rawText(parsed?.error?.message || parsed?.message || parsed?.error || raw); }
    catch { return raw; }
  }
  if (typeof raw === 'object') return raw.error?.message || raw.message || JSON.stringify(raw);
  return String(raw);
}

/**
 * Translate an OpenRouter error object (HTTP body or mid-stream event) into a
 * sentence a person can act on. `code` is the HTTP status, or the event's
 * error.code, which is usually numeric but can be a string such as
 * "server_error". Branches use metadata.error_type first: it is the typed
 * category OpenRouter recommends over status codes.
 */
export function describeOpenRouterError({ code, message = '', metadata = {}, model = '', generationId = '', partial = false } = {}) {
  const status = Number.isInteger(code) ? code : Number.isInteger(Number(code)) && String(code).trim() ? Number(code) : 0;
  const type = typeof metadata?.error_type === 'string' ? metadata.error_type : '';
  const text = String(message || '');
  const raw = rawText(metadata?.raw);
  const providerName = typeof metadata?.provider_name === 'string' ? metadata.provider_name : '';
  const httpLabel = status ? ` (HTTP ${status})` : typeof code === 'string' && code ? ` (${code})` : '';
  const isFree = /:free$/.test(model) || model === 'openrouter/free' || /free-models-per/i.test(text);
  let headline, hint = '';

  if (type === 'authentication' || status === 401) {
    headline = /no (cookie )?auth credentials/i.test(text) ? 'OpenRouter received no API key.' : /user not found/i.test(text) ? 'OpenRouter does not recognise this API key: it belongs to no account, so it was probably deleted or mistyped.' : `OpenRouter rejected the API key${httpLabel}.`;
    hint = `Check the key in Configuration → OpenRouter API key. Keys can be disabled, deleted, or expire; create or review them at ${OPENROUTER_LINKS.keys}.`;
  } else if (type === 'payment_required' || status === 402) {
    if (metadata?.limit_source === 'openrouter_in_flight_budget') {
      headline = 'Your OpenRouter balance is already committed to requests still running.';
      hint = 'Wait for them to finish, then retry.';
    } else {
      headline = `Not enough OpenRouter credits for this request${httpLabel}.`;
      hint = `OpenRouter reserves credit for the whole Response limit (max_tokens) before it starts. Add credits at ${OPENROUTER_LINKS.credits}, lower the Response limit, or choose a free model (an id ending in :free).`;
    }
  } else if (status === 403 && metadata?.limit_source) {
    const spent = money(Number(metadata.spend_usd)), limit = money(Number(metadata.limit_usd));
    const reset = metadata.resets_at ? `It resets on ${localTime(metadata.resets_at)}.` : 'It does not reset by itself.';
    headline = `A spending limit was reached${spent && limit ? ` (${spent} of ${limit})` : ''}${httpLabel}. ${reset}`;
    hint = metadata.limit_source === 'openrouter_key_limit' ? `Raise this key's credit limit at ${OPENROUTER_LINKS.keys}, or use another key.` : 'Raise the budget in your OpenRouter workspace settings, or wait for the reset.';
  } else if (Array.isArray(metadata?.reasons) || type === 'content_policy_violation' || type === 'refusal') {
    const reasons = Array.isArray(metadata?.reasons) && metadata.reasons.length ? `: ${metadata.reasons.join(', ')}` : '';
    headline = `${providerName || 'The model provider'} declined this request under its content policy${reasons}${httpLabel}.`;
    hint = `${metadata?.flagged_input ? `Flagged text: "${clip(metadata.flagged_input, 120)}". ` : ''}Rephrase the prompt, or choose a model from a different provider.`;
  } else if (status === 403) {
    headline = Array.isArray(metadata?.patterns) ? 'An OpenRouter guardrail blocked this request.' : `OpenRouter refused this request${httpLabel}.`;
    hint = 'Check the guardrails and permissions of this key in your OpenRouter settings.';
  } else if (type === 'rate_limit_exceeded' || status === 429) {
    const headers = metadata?.headers && typeof metadata.headers === 'object' ? metadata.headers : {};
    const reset = localTime(headers['X-RateLimit-Reset'] ?? headers['x-ratelimit-reset']);
    if (/upstream/i.test(`${text} ${raw}`)) {
      headline = `${providerName || 'The model provider'} is rate-limiting OpenRouter right now (upstream)${httpLabel}.`;
      hint = `This is common on popular free models and is not your account's limit. Retry in a minute, choose another model, or add your own provider key at ${OPENROUTER_LINKS.byok}.`;
    } else if (isFree) {
      headline = `The free-model rate limit was reached${httpLabel}.${reset ? ` It resets on ${reset}.` : ''}`;
      hint = 'Free models allow 20 requests per minute and 50 per day, or 1,000 per day after buying at least 10 credits. Wait, or choose a paid model.';
    } else {
      headline = `Too many requests${httpLabel}.${reset ? ` The limit resets on ${reset}.` : ''}`;
      hint = 'Wait a moment and retry.';
    }
  } else if (status === 404 || /no endpoints found/i.test(text)) {
    if (/data policy|privacy|training|publication/i.test(text)) {
      headline = 'No provider of this model is allowed by your OpenRouter privacy settings.';
      hint = `Free models usually require allowing providers that may train on or publish prompts. Review ${OPENROUTER_LINKS.privacy}, or choose another model.`;
    } else {
      headline = `No provider currently serves this model${httpLabel}.`;
      hint = 'It may have been retired or renamed. Refresh the model list in Configuration and choose another model.';
    }
  } else if (type === 'context_length_exceeded' || /context (length|window)|maximum context|too many tokens|prompt is too long/i.test(text)) {
    headline = 'The conversation no longer fits this model\'s context window.';
    hint = 'Start a new conversation, shorten the message, lower the Response limit, or choose a model with a larger context.';
  } else if (/not a valid model id|invalid model/i.test(text)) {
    headline = `OpenRouter does not know the model "${model || 'selected'}".`;
    hint = 'Model ids change when models are retired. Refresh the model list in Configuration and select one from it.';
  } else if (type === 'timeout' || status === 408) {
    headline = `The model took too long to answer OpenRouter${httpLabel}.`;
    hint = 'Retry, shorten the request, or choose a faster model.';
  } else if (type === 'provider_overloaded' || type === 'provider_unavailable' || status === 502) {
    headline = `${providerName ? `The provider ${providerName}` : 'The model\'s provider'} is down, overloaded, or returned an invalid answer${httpLabel}.`;
    hint = 'Retry shortly, or choose another model.';
  } else if (status === 503) {
    headline = `No provider is available for this model right now${httpLabel}.`;
    hint = 'Retry later, or choose another model.';
  } else if (status >= 520 && status <= 530) {
    headline = `OpenRouter's network edge could not reach its servers${httpLabel}.`;
    hint = `Retry shortly. If it persists, check ${OPENROUTER_LINKS.status}.`;
  } else if (type === 'server' || status >= 500) {
    headline = `OpenRouter had an internal error${httpLabel}.`;
    hint = `Retry. If it persists, check ${OPENROUTER_LINKS.status}.`;
  } else if (status === 400) {
    headline = 'OpenRouter rejected the request as invalid (HTTP 400).';
    hint = 'Not every model supports every setting. Check stop sequences, JSON format, and the Advanced Configuration values.';
  } else {
    headline = `OpenRouter reported an error${httpLabel}.`;
  }

  const details = [];
  if (text) details.push(`OpenRouter said: "${clip(text, 600)}"`);
  if (raw && raw !== text) details.push(`${providerName || 'Provider'} said: "${clip(raw, 400)}"`);
  else if (providerName && !headline.includes(providerName)) details.push(`Provider: ${providerName}.`);
  if (partial) details.push('The partial answer above is kept for reference but will not be used as conversation history.');
  if (generationId) details.push(`Generation ${generationId} (see ${OPENROUTER_LINKS.activity}).`);
  const error = new Error([headline, hint, ...details].filter(Boolean).join(' '));
  Object.assign(error, { status, type });
  return error;
}

/** Read an error body that may be JSON, a Cloudflare HTML page, or empty. */
async function errorFromResponse(response, model) {
  let body = '';
  try { body = await response.text(); } catch { /* The status alone is still useful. */ }
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* Not JSON: an HTML or plain-text page. */ }
  const error = parsed?.error;
  if (error && typeof error === 'object') {
    return describeOpenRouterError({ code: response.status, message: error.message, metadata: error.metadata, model, generationId: response.headers.get('X-Generation-Id') || '' });
  }
  const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1];
  const message = typeof error === 'string' ? error : title || (/^\s*</.test(body) ? response.statusText : body);
  return describeOpenRouterError({ code: response.status, message, model });
}

function explainFailure(error, { timedOut, cancelled, timeoutSeconds, started }) {
  if (timedOut) {
    return new Error(`The OpenRouter request did not finish within ${timeoutSeconds} seconds. Increase Request timeout in Advanced Configuration, lower the Response limit, or choose a faster model.`);
  }
  if (cancelled) return new DOMException('Request cancelled.', 'AbortError');
  if (error instanceof TypeError) {
    return new Error(started
      ? 'The connection to OpenRouter dropped during the response. Retry this turn; if it keeps happening, check your network or choose another model.'
      : 'Cannot reach OpenRouter (openrouter.ai). Check your internet connection, and that no firewall, proxy, VPN, DNS filter, or browser extension such as an ad blocker blocks openrouter.ai.');
  }
  return error;
}

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, 'X-Title': 'Guanaco' };
}

async function getJSON(path, { signal, apiKey } = {}) {
  const scope = abortScope(signal, METADATA_TIMEOUT_SECONDS);
  try {
    const response = await fetch(`${OPENROUTER_API}${path}`, { signal: scope.signal, cache: 'no-store', headers: apiKey ? authHeaders(apiKey) : {} });
    if (!response.ok) throw await errorFromResponse(response);
    let data;
    try { data = await response.json(); }
    catch { throw new Error('OpenRouter returned a response that is not valid JSON. Retry shortly.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('OpenRouter returned an unexpected response.');
    if (data.error) throw describeOpenRouterError({ code: data.error.code, message: data.error.message, metadata: data.error.metadata });
    return data;
  } catch (error) {
    throw explainFailure(error, { timedOut: scope.timedOut, cancelled: Boolean(signal?.aborted), timeoutSeconds: METADATA_TIMEOUT_SECONDS, started: false });
  } finally { scope.cleanup(); }
}

/** Per-million-token price text from OpenRouter's per-token strings. */
function priceLabel(pricing) {
  const input = Number(pricing?.prompt), output = Number(pricing?.completion);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return 'variable price';
  if (input === 0 && output === 0) return 'free';
  const perMillion = value => `$${(value * 1e6).toFixed(value * 1e6 < 10 ? 2 : 0)}`;
  return `${perMillion(input)}/M in · ${perMillion(output)}/M out`;
}

let catalogue = null;
let catalogueRequest = null;

/**
 * List chat-capable models. The catalogue is public, so no key is needed.
 * Entries use `name` (the model id) like Ollama's, plus display metadata.
 * The result is remembered so streamChat can tell whether a model supports
 * or requires reasoning before choosing how to express Think.
 */
export async function listModels(config, { signal } = {}) {
  const data = await getJSON('/models', { signal });
  if (!Array.isArray(data.data)) throw new Error('OpenRouter returned an invalid model list.');
  const models = data.data
    .filter(model => model && typeof model.id === 'string' && model.id
      && (!Array.isArray(model.architecture?.output_modalities) || model.architecture.output_modalities.includes('text')))
    .map(model => {
      const supported = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
      const context = Number(model.context_length) || Number(model.top_provider?.context_length) || 0;
      const price = priceLabel(model.pricing);
      return {
        name: model.id,
        label: `${model.id} · ${price}${context ? ` · ${Math.round(context / 1024)}K ctx` : ''}`,
        displayName: typeof model.name === 'string' ? model.name : model.id,
        contextLength: context,
        price,
        free: price === 'free',
        reasoning: {
          supported: supported.includes('reasoning') || Boolean(model.reasoning),
          mandatory: model.reasoning?.mandatory === true,
          known: Boolean(model.reasoning) || supported.length > 0,
        },
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  catalogue = { at: Date.now(), byId: new Map(models.map(model => [model.name, model])) };
  return models;
}

/** Model metadata from a recent catalogue, fetching it when missing or stale. */
async function modelInfo(id, signal) {
  if (!catalogue || Date.now() - catalogue.at > CATALOGUE_TTL_MS) {
    catalogueRequest ||= listModels({}, { signal }).catch(() => null).finally(() => { catalogueRequest = null; });
    await catalogueRequest;
  }
  return catalogue?.byId.get(id) || null;
}

/** Account and limits for an API key: GET /key. Rejects an invalid key. */
export async function keyInfo(apiKey, { signal } = {}) {
  if (!apiKey) throw new Error(`No OpenRouter API key is set. Add one in Configuration → OpenRouter API key; create it at ${OPENROUTER_LINKS.keys}.`);
  const { data } = await getJSON('/key', { signal, apiKey });
  if (!data || typeof data !== 'object') throw new Error('OpenRouter returned an invalid key description.');
  const daily = data.free_model_daily_requests;
  return {
    label: typeof data.label === 'string' ? data.label : '',
    usage: Number.isFinite(data.usage) ? data.usage : null,
    limit: Number.isFinite(data.limit) ? data.limit : null,
    limitRemaining: Number.isFinite(data.limit_remaining) ? data.limit_remaining : null,
    limitReset: typeof data.limit_reset === 'string' ? data.limit_reset : '',
    isFreeTier: data.is_free_tier === true,
    freeDaily: daily && Number.isFinite(daily.limit) ? { used: daily.used, limit: daily.limit, remaining: daily.remaining } : null,
  };
}

/** One human sentence summarising keyInfo() for status lines. */
export function describeKey(info) {
  const parts = [info.label ? `Key "${info.label}"` : 'Key accepted'];
  if (info.limit !== null) parts.push(`${money(info.limitRemaining ?? 0)} of ${money(info.limit)} limit left${info.limitReset ? ` (resets ${info.limitReset})` : ''}`);
  else parts.push('no key spending limit');
  if (info.usage !== null) parts.push(`${money(info.usage)} used`);
  if (info.freeDaily) parts.push(`${info.freeDaily.remaining} of ${info.freeDaily.limit} free-model requests left today`);
  if (info.isFreeTier) parts.push('free tier (no credits purchased)');
  return parts.join(' · ');
}

/** Map Guanaco's settings onto an OpenAI-style chat completion request. */
export function requestBody(config, messages, info = null) {
  const body = {
    model: config.model,
    messages,
    stream: true,
    usage: { include: true },
    temperature: config.temperature,
    top_p: config.topP,
    repetition_penalty: config.repeatPenalty,
  };
  // Ollama's "disabled" values mean "omit" here; OpenRouter rejects or
  // misreads 0/-1. numCtx and keepAlive are Ollama-only and never sent.
  if (config.topK > 0) body.top_k = config.topK;
  if (config.seed >= 0) body.seed = config.seed;
  if (config.numPredict > 0) body.max_tokens = config.numPredict;
  if (config.stop.length) body.stop = [...config.stop];
  if (config.format === 'json') body.response_format = { type: 'json_object' };
  // Think on asks for reasoning. Think off sends effort "none" only when the
  // catalogue says the model can switch reasoning off: models that require it
  // reject "none", and others ignore the parameter anyway.
  if (config.think) {
    if (!info || info.reasoning.supported || !info.reasoning.known) body.reasoning = { enabled: true };
  } else if (info?.reasoning.supported && !info.reasoning.mandatory) {
    body.reasoning = { effort: 'none' };
  }
  return body;
}

function reasoningDelta(delta) {
  if (typeof delta.reasoning === 'string') return delta.reasoning;
  if (!Array.isArray(delta.reasoning_details)) return '';
  // Encrypted entries carry no readable text; summaries and text do.
  return delta.reasoning_details.map(item => (typeof item?.text === 'string' ? item.text : typeof item?.summary === 'string' ? item.summary : '')).join('');
}

/**
 * Stream one chat completion. onChunk receives {content, thinking} deltas; the
 * resolved value uses Ollama-compatible metric names (eval_count,
 * total_duration in nanoseconds, done_reason) plus cost, provider, and model,
 * so the chat view can show either provider's turn the same way.
 *
 * Success requires `data: [DONE]` or a finish_reason. A 200 response can still
 * fail: OpenRouter reports later errors as an SSE event with an `error` object
 * and finish_reason "error", sometimes as the only event.
 */
export async function streamChat(config, messages, { signal, onChunk = () => {}, apiKey = '' } = {}) {
  if (!apiKey) throw new Error(`No OpenRouter API key is set. Add one in Configuration → OpenRouter API key, then retry; create a key at ${OPENROUTER_LINKS.keys}.`);
  const started = performance.now();
  const scope = abortScope(signal, config.timeoutSeconds);
  let reader, responseStarted = false, generationId = '', received = false;
  const state = { done: false, finishReason: '', usage: null, model: '', provider: '' };
  try {
    const info = await modelInfo(config.model, scope.signal);
    const response = await fetch(`${OPENROUTER_API}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders(apiKey) },
      body: JSON.stringify(requestBody(config, messages, info)),
      signal: scope.signal,
    });
    generationId = response.headers.get('X-Generation-Id') || '';
    if (!response.ok) throw await errorFromResponse(response, config.model);
    responseStarted = true;
    if (!/text\/event-stream/i.test(response.headers.get('Content-Type') || '')) {
      // A non-streamed body, typically {"error": …} with HTTP 200.
      let data = null;
      try { data = JSON.parse(await response.text()); } catch { /* Reported below. */ }
      if (data?.error) throw describeOpenRouterError({ code: data.error.code, message: data.error.message, metadata: data.error.metadata, model: config.model, generationId });
      throw new Error('OpenRouter answered without a response stream. Retry this turn; if it repeats, choose another model.');
    }
    if (!response.body) throw new Error('This browser did not provide a response stream.');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Each `data:` line is one JSON event (OpenRouter never splits an event
    // over several data lines). Lines starting with ':' are keep-alive
    // comments such as ": OPENROUTER PROCESSING"; other SSE fields are unused.
    const consume = rawLine => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith('data:') || state.done) return;
      const data = line.slice(5).trimStart();
      if (data === '[DONE]') { state.done = true; return; }
      let event;
      try { event = JSON.parse(data); }
      catch { throw new Error('OpenRouter sent malformed data in its response stream. Retry this turn.'); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('OpenRouter sent an invalid stream event. Retry this turn.');
      state.model = typeof event.model === 'string' ? event.model : state.model;
      state.provider = typeof event.provider === 'string' ? event.provider : state.provider;
      if (event.error) {
        const metadata = { provider_name: state.provider || undefined, ...(event.error.metadata || {}) };
        throw describeOpenRouterError({ code: event.error.code, message: event.error.message, metadata, model: config.model, generationId: generationId || event.id || '', partial: received });
      }
      if (event.usage && typeof event.usage === 'object') state.usage = event.usage;
      const choice = Array.isArray(event.choices) ? event.choices[0] : null;
      if (!choice) return;
      const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {};
      const content = typeof delta.content === 'string' ? delta.content : '';
      const thinking = reasoningDelta(delta);
      if (content || thinking) { received = received || Boolean(content); onChunk({ content, thinking }); }
      if (choice.finish_reason === 'error') {
        throw describeOpenRouterError({ message: 'The response stream ended with an error.', metadata: { provider_name: state.provider || undefined }, model: config.model, generationId: generationId || event.id || '', partial: received });
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) state.finishReason = choice.finish_reason;
    };
    while (!state.done) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline;
      while (!state.done && (newline = buffer.indexOf('\n')) !== -1) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) break;
      if (buffer.length > MAX_EVENT_BYTES) throw new Error('An OpenRouter stream event exceeded the maximum supported size.');
    }
    if (!state.done && buffer.trim()) consume(buffer);
    if (!state.done && !state.finishReason) {
      throw new Error(`OpenRouter closed the response before it finished${received ? '; the partial answer is kept but will not be used as history' : ''}. Retry this turn.${generationId ? ` Generation ${generationId}.` : ''}`);
    }
    const usage = state.usage || {};
    const metrics = {
      done: true,
      done_reason: state.finishReason || 'stop',
      eval_count: usage.completion_tokens,
      prompt_eval_count: usage.prompt_tokens,
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
      cost: usage.cost,
      total_duration: Math.round((performance.now() - started) * 1e6),
      provider: state.provider,
      model: state.model,
      generation_id: generationId,
    };
    for (const key of Object.keys(metrics)) if (metrics[key] === undefined || metrics[key] === '' || metrics[key] === null) delete metrics[key];
    return metrics;
  } catch (error) {
    scope.controller.abort();
    throw explainFailure(error, { timedOut: scope.timedOut, cancelled: Boolean(signal?.aborted), timeoutSeconds: config.timeoutSeconds, started: responseStarted });
  } finally {
    if (reader) {
      try { await reader.cancel(); } catch { /* Aborted fetch streams can reject cancellation. */ }
      reader.releaseLock();
    }
    scope.cleanup();
  }
}
