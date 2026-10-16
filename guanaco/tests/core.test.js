/**
 * Open /tests/ using the same static HTTP server as the app. This suite uses
 * only browser APIs and injected memory storage; it cannot overwrite a user's
 * settings or conversations. Automation may await window.testsDone.
 */
import { DEFAULT_CONFIG, validateConfig, parseConfigImport, exportConfig } from '../js/core/config.js';
import { createStore, STORAGE_KEYS } from '../js/core/store.js';
import { RequestQueue } from '../js/core/queue.js';
import { listModels, streamChat } from '../js/core/api.js';
import { THEMES, DEFAULT_THEME, createThemeController } from '../js/ui/theme.js';
import * as openrouter from '../js/core/openrouter.js';
import { createCredentials, normalizeApiKey, maskApiKey } from '../js/core/credentials.js';
import { createProviders } from '../js/core/providers.js';

const cases = [];
const test = (name, run) => cases.push({ name, run });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const assert = (condition, message = 'Assertion failed.') => { if (!condition) throw new Error(message); };
const equal = (actual, expected, message = '') => {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}\nExpected: ${JSON.stringify(expected)}\nReceived: ${JSON.stringify(actual)}`);
};
const throws = (run, pattern) => {
  try { run(); } catch (error) {
    if (pattern) assert(pattern.test(error.message), `Unexpected error: ${error.message}`);
    return;
  }
  throw new Error('Expected an exception.');
};
const rejects = async (run, pattern) => {
  try { await run(); } catch (error) {
    if (pattern) assert(pattern.test(error.message), `Unexpected error: ${error.message}`);
    return error;
  }
  throw new Error('Expected a rejected promise.');
};
const until = async predicate => {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for a test condition.');
    await tick();
  }
};
const memoryStorage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
const freshStore = () => createStore({ storage: memoryStorage() });
const withFetch = async (replacement, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try { return await run(); } finally { globalThis.fetch = original; }
};

test('Configuration validation and versioned JSON round trips', () => {
  equal(parseConfigImport(exportConfig(DEFAULT_CONFIG)), validateConfig(DEFAULT_CONFIG));
  equal(parseConfigImport('{"model":"example"}').model, 'example');
  for (const value of [
    { serverUrl: 'javascript:alert(1)' }, { serverUrl: 'http://user:pass@localhost' },
    { serverUrl: 'http://localhost/?token=secret' }, { think: 'false' }, { numCtx: 5 },
    { numPredict: -3 }, { stop: [''] }, { unknownField: true },
  ]) throws(() => validateConfig(value));
  throws(() => parseConfigImport('{invalid}'), /valid JSON/);
  throws(() => parseConfigImport({ schema: 'guanaco.configuration', version: 2, config: {} }), /version/);
  throws(() => parseConfigImport({ schema: 'guanaco.configuration', version: 1, config: {}, extra: true }), /Unknown/);
});

test('Global defaults, chat overrides, and queued jobs use independent snapshots', () => {
  const store = freshStore();
  const chat = store.createChat();
  store.setConfig({ ...DEFAULT_CONFIG, model: 'new-default' });
  equal(chat.config.model, DEFAULT_CONFIG.model);
  assert(Object.isFrozen(chat.config) && Object.isFrozen(chat.config.stop));
  const queue = new RequestQueue(store);
  queue.setPaused(true);
  const job = queue.enqueue(chat.id, 'Keep my original settings.');
  store.updateChatConfig(chat.id, { ...DEFAULT_CONFIG, model: 'custom-model' });
  equal(chat.configMode, 'custom');
  equal(job.config.model, DEFAULT_CONFIG.model);
  store.updateChatConfig(chat.id, null);
  equal(chat.configMode, 'global');
  equal(chat.config.model, 'new-default');
  equal(store.createChat().config.model, 'new-default');
  throws(() => store.deleteChat(chat.id), /pending/);
  queue.cancel(job.id);
  store.deleteChat(chat.id);
  assert(!store.state.chats.some(item => item.id === chat.id));
});

test('FIFO never overlaps requests and resolves same-chat history at execution', async () => {
  const store = freshStore();
  const firstChat = store.createChat();
  const secondChat = store.createChat();
  const gates = [];
  const messages = [];
  let active = 0;
  let maximum = 0;
  const queue = new RequestQueue(store, async (config, history, { onChunk }) => {
    active++;
    maximum = Math.max(maximum, active);
    messages.push(history);
    const response = `Answer ${messages.length}`;
    await new Promise(resolve => gates.push(resolve));
    onChunk({ content: response, thinking: 'Internal reasoning.' });
    active--;
    return { done: true, eval_count: 2 };
  });
  const first = queue.enqueue(firstChat.id, 'First');
  const second = queue.enqueue(secondChat.id, 'Second');
  const third = queue.enqueue(firstChat.id, 'Third');
  await until(() => gates.length === 1);
  equal(queue.activeJobId, first.id);
  equal(queue.position(second.id), 1);
  equal(queue.position(third.id), 2);
  equal(messages.length, 1);
  gates.shift()();
  await until(() => gates.length === 1);
  equal(queue.activeJobId, second.id);
  gates.shift()();
  await until(() => gates.length === 1);
  equal(messages[2].map(message => message.content), ['You are a helpful assistant.', 'First', 'Answer 1', 'Third']);
  gates.shift()();
  await until(() => queue.activeJobId === null);
  equal(maximum, 1);
  assert(store.state.jobs.every(job => job.status === 'completed'));
  equal(firstChat.turns[0].thinking, 'Internal reasoning.');
});

test('Pause preserves queued work; cancellation and retry preserve history', async () => {
  const store = freshStore();
  const chat = store.createChat();
  let calls = 0;
  const queue = new RequestQueue(store, async () => { calls++; return { done: true }; });
  queue.setPaused(true);
  const job = queue.enqueue(chat.id, 'Retry this prompt.');
  await tick();
  equal(calls, 0);
  queue.cancel(job.id);
  equal(job.status, 'cancelled');
  const retry = queue.retry(chat.id, job.turnId);
  equal(chat.turns.length, 1);
  throws(() => queue.retry(chat.id, job.turnId));
  queue.setPaused(false);
  await until(() => retry.status === 'completed');
  equal(calls, 1);
  queue.setPaused(true);
  const old = queue.enqueue(chat.id, 'Cancelled older turn');
  queue.cancel(old.id);
  const later = queue.enqueue(chat.id, 'Later turn');
  queue.setPaused(false);
  await until(() => later.status === 'completed');
  throws(() => queue.retry(chat.id, old.turnId), /latest conversation turn/);
});

test('Cancelling a running request holds its slot until the client settles', async () => {
  const store = freshStore();
  const chat = store.createChat();
  let release;
  let signal;
  let secondStarted = false;
  const queue = new RequestQueue(store, async (config, messages, options) => {
    if (messages.at(-1).content === 'First') {
      signal = options.signal;
      await new Promise(resolve => { release = resolve; });
    } else {
      secondStarted = true;
      // The cancelled first turn must not become model history.
      equal(messages.map(message => message.content), ['You are a helpful assistant.', 'Second']);
    }
    return { done: true };
  });
  const first = queue.enqueue(chat.id, 'First');
  const second = queue.enqueue(chat.id, 'Second');
  await until(() => Boolean(release));
  queue.cancel(first.id);
  await tick();
  assert(signal.aborted);
  equal(first.status, 'running');
  equal(secondStarted, false);
  release();
  await until(() => second.status === 'completed');
  equal(first.status, 'cancelled');
});

test('A failed request does not block later work or enter model history', async () => {
  const store = freshStore();
  const chat = store.createChat();
  const queue = new RequestQueue(store, async (config, messages, { onChunk }) => {
    if (messages.at(-1).content === 'Fail') {
      onChunk({ content: 'Partial response' });
      throw new Error('Deliberate test failure');
    }
    equal(messages.map(message => message.content), ['You are a helpful assistant.', 'Continue']);
    return { done: true };
  });
  const first = queue.enqueue(chat.id, 'Fail');
  const second = queue.enqueue(chat.id, 'Continue');
  await until(() => second.status === 'completed');
  equal(first.status, 'failed');
  equal(chat.turns[0].content, 'Partial response');
  equal(chat.turns[0].error, 'Deliberate test failure');
});

test('Reload marks unfinished work interrupted without replaying it', async () => {
  const storage = memoryStorage();
  const store = createStore({ storage });
  const chat = store.createChat();
  const queue = new RequestQueue(store);
  queue.setPaused(true);
  const first = queue.enqueue(chat.id, 'Previously running');
  const second = queue.enqueue(chat.id, 'Previously queued');
  first.status = chat.turns[0].status = 'running';
  store.save();
  const reloaded = createStore({ storage });
  assert(reloaded.state.jobs.every(job => job.status === 'interrupted'));
  assert(reloaded.state.chats[0].turns.every(turn => turn.status === 'interrupted'));
  assert(reloaded.state.chats[0].turns[0].error.includes('interrupted'));
  let calls = 0;
  const freshQueue = new RequestQueue(reloaded, async () => { calls++; return { done: true }; });
  freshQueue.setPaused(false);
  await tick();
  equal(calls, 0);
  equal(second.status, 'queued');
  // Keep this isolated fixture from persisting a fake running state later.
  queue.cancel(second.id);
});

test('Corrupt storage and quota failures leave an operational in-memory app', () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEYS.config, '{broken');
  const store = createStore({ storage });
  assert(store.storageError.includes('could not be loaded'));
  equal(store.state.config.model, DEFAULT_CONFIG.model);
  const unavailable = createStore({ storage: {
    getItem: () => null,
    setItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
  } });
  const chat = unavailable.createChat();
  assert(unavailable.state.chats.includes(chat));
  assert(unavailable.storageError.includes('could not be saved'));
});

test('Streaming handles fragmented UTF-8, thinking, final metrics, and native options', async () => {
  const bytes = new TextEncoder().encode(
    '{"message":{"content":"hé🙂","thinking":"reason"},"done":false}\r\n{"done":true,"eval_count":3}\n',
  );
  let request;
  await withFetch(async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return new Response(new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }));
  }, async () => {
    let content = '';
    let thinking = '';
    const metrics = await streamChat(DEFAULT_CONFIG, [{ role: 'user', content: 'Hello' }], {
      onChunk: chunk => { content += chunk.content; thinking += chunk.thinking; },
    });
    equal(content, 'hé🙂');
    equal(thinking, 'reason');
    equal(metrics.eval_count, 3);
    equal(request.url, 'http://localhost:11434/api/chat');
    equal(request.body.think, false);
    equal(request.body.options.num_ctx, DEFAULT_CONFIG.numCtx);
    equal(request.body.options.num_predict, DEFAULT_CONFIG.numPredict);
  });
});

test('Stream errors, malformed JSON, HTTP errors, and missing completion reject', async () => {
  const responses = [
    ['{"message":{"content":"partial"}}\n', 200, /before completion/],
    ['{"error":"Model failed"}\n', 200, /Model failed/],
    ['not JSON\n', 200, /malformed JSON/],
    ['{"error":"Unknown model"}', 404, /HTTP 404.*Unknown model/],
  ];
  for (const [body, status, pattern] of responses) {
    await withFetch(async () => new Response(body, { status }), () => rejects(() => streamChat(DEFAULT_CONFIG, []), pattern));
  }
  await withFetch(async () => new Response('null'), () => rejects(() => listModels(DEFAULT_CONFIG), /invalid JSON/));
});

test('Timeout aborts the transport and user cancellation retains AbortError', async () => {
  let aborted = false;
  await withFetch(async (url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      const abort = () => { aborted = true; controller.error(signal.reason); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    },
  })), async () => {
    // A tiny direct-client timeout keeps this test fast. User-facing config
    // validation independently enforces a minimum of one second.
    await rejects(() => streamChat({ ...DEFAULT_CONFIG, timeoutSeconds: 0.02 }, []), /timed out/);
    assert(aborted, 'Timeout must cancel the underlying transport.');
    const controller = new AbortController();
    const pending = streamChat(DEFAULT_CONFIG, [], { signal: controller.signal });
    controller.abort();
    const error = await rejects(() => pending);
    equal(error.name, 'AbortError');
  });
});

test('Theme choice is validated, applied, remembered, and survives blocked storage', () => {
  const storage = memoryStorage();
  const root = document.createElement('div');
  const theme = createThemeController({ storage, root });
  equal([theme.current, root.dataset.theme], [DEFAULT_THEME, DEFAULT_THEME]);
  equal(storage.getItem(STORAGE_KEYS.theme), null, 'Nothing is saved until a theme is chosen.');
  assert(theme.set('oled'), 'Writable storage saves the theme.');
  equal([theme.current, root.dataset.theme, storage.getItem(STORAGE_KEYS.theme)], ['oled', 'oled', 'oled']);
  throws(() => theme.set('sepia'), /Unknown theme/);
  equal(theme.current, 'oled');
  equal(createThemeController({ storage, root: document.createElement('div') }).current, 'oled', 'A new page restores the saved theme.');
  storage.setItem(STORAGE_KEYS.theme, 'retired-theme');
  equal([theme.sync(), root.dataset.theme], [DEFAULT_THEME, DEFAULT_THEME], 'Unknown saved values fall back to the default.');
  const denied = () => { throw new DOMException('Storage is disabled.', 'SecurityError'); };
  const blocked = createThemeController({ root, storage: { getItem: denied, setItem: denied } });
  equal(blocked.current, DEFAULT_THEME);
  equal(blocked.set('dark'), false, 'A refused write is reported.');
  equal(root.dataset.theme, 'dark', 'The theme still applies for this session.');
});

test('Every theme has a complete palette and the pre-paint script uses its key', async () => {
  const read = async path => (await fetch(path, { cache: 'no-store' })).text();
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(await read('../css/styles.css'));
  const palettes = new Map();
  const collect = rules => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) collect(rule.cssRules);
      const id = /\[data-theme="([^"]+)"\]/.exec(rule.selectorText || '')?.[1];
      if (id) palettes.set(id, new Set(Array.from(rule.style)));
    }
  };
  collect(sheet.cssRules);
  equal([...palettes.keys()].sort(), THEMES.map(theme => theme.id).sort(), 'Stylesheet palettes must match the registered themes.');
  const reference = palettes.get(DEFAULT_THEME);
  assert(reference.has('color-scheme') && reference.has('--page'), 'The default palette defines the base tokens.');
  for (const [id, tokens] of palettes) {
    const missing = [...reference].filter(name => !tokens.has(name));
    const extra = [...tokens].filter(name => !reference.has(name));
    assert(!missing.length && !extra.length, `The ${id} palette must define the same tokens as ${DEFAULT_THEME}. Missing: ${missing.join(', ') || 'none'}. Extra: ${extra.join(', ') || 'none'}.`);
  }
  assert(THEMES.every(theme => /^[a-z][a-z0-9-]*$/.test(theme.id) && theme.label), 'Theme ids are lowercase identifiers with labels.');
  assert((await read('../index.html')).includes(`localStorage.getItem('${STORAGE_KEYS.theme}')`), 'index.html must read the same theme key before the first paint.');
});

const OPENROUTER = { ...DEFAULT_CONFIG, provider: 'openrouter', model: 'test/reasoner', temperature: 0.5, topK: 0, seed: -1, numPredict: -1 };
const catalogue = {
  data: [
    { id: 'test/reasoner', name: 'Test: Reasoner', context_length: 131072, pricing: { prompt: '0.0000001', completion: '0.0000004' }, supported_parameters: ['reasoning', 'temperature'], reasoning: { mandatory: false }, architecture: { output_modalities: ['text'] } },
    { id: 'test/always-thinks', name: 'Test: Always', context_length: 8192, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['reasoning'], reasoning: { mandatory: true } },
    { id: 'test/plain:free', name: 'Test: Plain (free)', context_length: 4096, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['temperature'] },
    { id: 'test/image-maker', name: 'Images only', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['image'] } },
  ],
};
const sse = (chunks, { split = false, status = 200 } = {}) => {
  const bytes = new TextEncoder().encode(chunks.join(''));
  return new Response(new ReadableStream({
    start(controller) {
      if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      else controller.enqueue(bytes);
      controller.close();
    },
  }), { status, headers: { 'Content-Type': 'text/event-stream', 'X-Generation-Id': 'gen-test' } });
};
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
// Routes OpenRouter calls: the public catalogue, then whatever `chat` returns.
const openRouterFetch = chat => async (url, options) => (String(url).endsWith('/models') ? jsonResponse(catalogue) : chat(url, options));

test('Provider selection validates and older configurations default to Ollama', () => {
  equal(validateConfig({}).provider, 'ollama', 'Configurations saved before providers existed keep using Ollama.');
  equal(parseConfigImport(exportConfig(OPENROUTER)).provider, 'openrouter');
  throws(() => validateConfig({ provider: 'openai' }), /Provider/);
  throws(() => validateConfig({ provider: 'openrouter', temperature: 3 }), /OpenRouter accepts a temperature/);
  throws(() => validateConfig({ provider: 'openrouter', repeatPenalty: 2.5 }), /repeat penalty/);
  equal(validateConfig({ temperature: 3 }).temperature, 3, 'Ollama keeps its wider range.');
});

test('OpenRouter streams SSE with comments, fragments, reasoning, and usage, and maps settings', async () => {
  const models = await withFetch(openRouterFetch(() => { throw new Error('No chat expected.'); }), () => openrouter.listModels(OPENROUTER));
  equal(models.map(model => model.name), ['test/always-thinks', 'test/plain:free', 'test/reasoner'], 'Sorted, chat-capable models only.');
  equal([models[1].free, models[2].price, models[2].reasoning.mandatory], [true, '$0.10/M in · $0.40/M out', false]);
  const requests = [];
  const stream = [
    ': OPENROUTER PROCESSING\n\n',
    'data: {"id":"gen-1","model":"test/reasoner","provider":"TestCloud","choices":[{"delta":{"reasoning":"Let me think."}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"hé🙂"}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"content":" done"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":5,"cost":0.00012,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
    'data: [DONE]\n\n',
  ];
  await withFetch(openRouterFetch((url, options) => { requests.push({ url, headers: options.headers, body: JSON.parse(options.body) }); return sse(stream, { split: true }); }), async () => {
    let content = '', thinking = '';
    const metrics = await openrouter.streamChat(OPENROUTER, [{ role: 'user', content: 'Hello' }], { apiKey: 'sk-or-v1-test', onChunk: chunk => { content += chunk.content; thinking += chunk.thinking; } });
    equal([content, thinking], ['hé🙂 done', 'Let me think.']);
    equal([metrics.done_reason, metrics.eval_count, metrics.prompt_eval_count, metrics.reasoning_tokens, metrics.cost, metrics.provider, metrics.generation_id], ['stop', 5, 7, 2, 0.00012, 'TestCloud', 'gen-test']);
    assert(metrics.total_duration > 0, 'Duration is reported in nanoseconds like Ollama.');
    await openrouter.streamChat({ ...OPENROUTER, think: true, topK: 40, seed: 7, numPredict: 300, stop: ['END'], format: 'json' }, [], { apiKey: 'sk-or-v1-test' });
    await openrouter.streamChat({ ...OPENROUTER, model: 'test/always-thinks' }, [], { apiKey: 'sk-or-v1-test' });
  });
  const [plain, tuned, mandatory] = requests;
  equal(plain.url, 'https://openrouter.ai/api/v1/chat/completions');
  equal(plain.headers.Authorization, 'Bearer sk-or-v1-test');
  equal([plain.body.stream, plain.body.temperature, plain.body.repetition_penalty], [true, 0.5, DEFAULT_CONFIG.repeatPenalty]);
  for (const omitted of ['max_tokens', 'top_k', 'seed', 'stop', 'response_format', 'num_ctx', 'keep_alive', 'options']) assert(!(omitted in plain.body), `${omitted} must be omitted.`);
  equal(plain.body.reasoning, { effort: 'none' }, 'Think off disables optional reasoning.');
  equal([tuned.body.max_tokens, tuned.body.top_k, tuned.body.seed, tuned.body.stop, tuned.body.response_format, tuned.body.reasoning], [300, 40, 7, ['END'], { type: 'json_object' }, { enabled: true }]);
  assert(!('reasoning' in mandatory.body), 'Models that must reason never receive effort "none".');
});

test('OpenRouter HTTP errors explain the cause and what to do next', async () => {
  const cases = [
    [401, { error: { code: 401, message: 'User not found.' } }, 'test/reasoner', /does not recognise this API key.*settings\/keys.*User not found/],
    [402, { error: { code: 402, message: 'This request requires more credits, or fewer max_tokens.' } }, 'test/reasoner', /Not enough OpenRouter credits.*lower the Response limit.*:free.*requires more credits/],
    [403, { error: { code: 403, message: 'Key limit exceeded', metadata: { limit_source: 'openrouter_key_limit', spend_usd: 5, limit_usd: 5, resets_at: null } } }, 'test/reasoner', /spending limit was reached \(\$5\.00 of \$5\.00\).*does not reset.*credit limit/],
    [403, { error: { code: 403, message: 'Input flagged', metadata: { reasons: ['violence'], flagged_input: 'bad words', provider_name: 'Mod' } } }, 'test/reasoner', /Mod declined.*violence.*Flagged text: "bad words"/],
    [404, { error: { code: 404, message: 'No endpoints found matching your data policy (Free model publication).' } }, 'test/plain:free', /privacy settings.*settings\/privacy/],
    [400, { error: { code: 400, message: "This endpoint's maximum context length is 4096 tokens." } }, 'test/plain:free', /no longer fits.*context window.*new conversation/],
    [400, { error: { code: 400, message: 'test/old is not a valid model ID' } }, 'test/old', /does not know the model "test\/old".*Refresh the model list/],
    [429, { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day.', metadata: { headers: { 'X-RateLimit-Reset': '1792195200000' } } } }, 'test/plain:free', /free-model rate limit.*resets on .*50 per day/],
    [429, { error: { code: 429, message: 'Provider returned error', metadata: { provider_name: 'Chutes', raw: 'test/plain:free is temporarily rate-limited upstream.' } } }, 'test/plain:free', /Chutes is rate-limiting OpenRouter.*upstream.*not your account.*Chutes said: "test\/plain:free is temporarily/],
    [502, { error: { code: 502, message: 'Provider returned error', metadata: { provider_name: 'Slowly' } } }, 'test/reasoner', /provider Slowly is down/],
    [503, { error: { code: 503, message: 'No instances available' } }, 'test/reasoner', /No provider is available.*Retry later/],
    [524, '<html><head><title>openrouter.ai | 524: A timeout occurred</title></head></html>', 'test/reasoner', /network edge.*HTTP 524.*status\.openrouter\.ai.*A timeout occurred/],
    [500, { error: { code: 500, message: 'Internal Server Error', metadata: { error_type: 'server' } } }, 'test/reasoner', /internal error.*Retry/],
  ];
  for (const [status, body, model, pattern] of cases) {
    await withFetch(openRouterFetch(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })), () => rejects(() => openrouter.streamChat({ ...OPENROUTER, model }, [], { apiKey: 'sk-or-v1-test' }), pattern));
  }
  let called = false;
  await withFetch(async () => { called = true; return jsonResponse({}); }, () => rejects(() => openrouter.streamChat(OPENROUTER, []), /No OpenRouter API key is set/));
  assert(!called, 'A missing key fails before any network request.');
});

test('OpenRouter mid-stream errors, truncated streams, and network failures reject clearly', async () => {
  const partial = 'data: {"choices":[{"delta":{"content":"Half an ans"}}]}\n\n';
  const failures = [
    [() => sse([partial, 'data: {"id":"gen-9","provider":"TestCloud","error":{"code":"server_error","message":"Upstream disconnected","metadata":{"error_type":"provider_unavailable"}},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}\n\n']), /provider TestCloud is down.*Upstream disconnected.*partial answer.*not be used as conversation history.*gen-test/],
    [() => sse(['data: {"error":{"code":429,"message":"Rate limit exceeded"},"choices":[{"finish_reason":"error"}]}\n\n']), /Too many requests \(HTTP 429\)/],
    [() => sse([partial]), /closed the response before it finished; the partial answer is kept/],
    [() => sse(['data: {not json\n\n']), /malformed data/],
    [() => jsonResponse({ error: { code: 502, message: 'Every provider failed' } }), /down, overloaded.*Every provider failed/],
    [() => { throw new TypeError('Failed to fetch'); }, /Cannot reach OpenRouter.*firewall.*ad blocker/],
  ];
  for (const [respond, pattern] of failures) {
    await withFetch(openRouterFetch(async () => respond()), () => rejects(() => openrouter.streamChat(OPENROUTER, [], { apiKey: 'sk-or-v1-test' }), pattern));
  }
  // A stream that delivered finish_reason is complete even without [DONE].
  await withFetch(openRouterFetch(async () => sse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"length"}]}\n'])), async () => {
    equal((await openrouter.streamChat(OPENROUTER, [], { apiKey: 'sk-or-v1-test' })).done_reason, 'length');
  });
  const controller = new AbortController();
  await withFetch(openRouterFetch(async (url, { signal }) => new Response(new ReadableStream({
    start(stream) {
      if (signal.aborted) stream.error(signal.reason);
      else signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } })), async () => {
    const pending = openrouter.streamChat(OPENROUTER, [], { apiKey: 'sk-or-v1-test', signal: controller.signal });
    await tick();
    controller.abort();
    equal((await rejects(() => pending)).name, 'AbortError');
    await rejects(() => openrouter.streamChat({ ...OPENROUTER, timeoutSeconds: 0.02 }, [], { apiKey: 'sk-or-v1-test' }), /did not finish within 0.02 seconds/);
  });
});

test('The OpenRouter key stays out of configuration and honours the remember choice', () => {
  const storage = () => {
    const values = new Map();
    return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  };
  const local = storage(), session = storage();
  const credentials = createCredentials({ localStorage: local, sessionStorage: session });
  equal([credentials.openRouterKey, credentials.persistence], ['', '']);
  equal(credentials.setOpenRouterKey('  Bearer sk-or-v1-abcdef0123456789\n', false), 'session');
  equal([credentials.openRouterKey, session.values.size, local.values.size], ['sk-or-v1-abcdef0123456789', 1, 0]);
  equal(credentials.setOpenRouterKey('sk-or-v1-abcdef0123456789', true), 'device');
  equal([credentials.persistence, session.values.size, local.values.size], ['device', 0, 1], 'Remembering moves the key, it does not copy it.');
  equal(local.values.get(STORAGE_KEYS.openrouterKey), 'sk-or-v1-abcdef0123456789');
  equal(maskApiKey(credentials.openRouterKey), 'sk-or-v1-…6789');
  credentials.clearOpenRouterKey();
  equal([credentials.openRouterKey, local.values.size, session.values.size], ['', 0, 0]);
  throws(() => normalizeApiKey('sk-or-v1 with spaces'), /spaces, line breaks/);
  throws(() => normalizeApiKey('   '), /Paste an OpenRouter API key/);
  const refused = { getItem: () => null, setItem: () => { throw new DOMException('Denied', 'SecurityError'); }, removeItem() {} };
  const fallback = createCredentials({ localStorage: refused, sessionStorage: refused });
  equal([fallback.setOpenRouterKey('sk-or-v1-x'), fallback.openRouterKey], ['memory', 'sk-or-v1-x'], 'Blocked storage keeps the key for this page.');
  assert(!JSON.stringify(validateConfig({ provider: 'openrouter' })).includes('sk-or'), 'Configurations never hold the key.');
  const store = freshStore();
  store.setConfig({ ...DEFAULT_CONFIG, provider: 'openrouter' });
  assert(!exportConfig(store.state.config).includes('sk-or'), 'Exports never hold the key.');
});

test('Providers route each request by its configuration and add the saved key', async () => {
  const calls = [];
  const credentials = { openRouterKey: 'sk-or-v1-routed' };
  const providers = createProviders({ credentials });
  await withFetch(async (url, options = {}) => {
    calls.push({ url: String(url), auth: options.headers?.Authorization });
    if (String(url).endsWith('/models')) return jsonResponse(catalogue);
    if (String(url).endsWith('/key')) return jsonResponse({ data: { label: 'Laptop', usage: 1.5, limit: 10, limit_remaining: 8.5, is_free_tier: false } });
    if (String(url).includes('openrouter.ai')) return sse(['data: {"choices":[{"delta":{"content":"cloud"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']);
    return new Response('{"message":{"content":"local"},"done":true}\n');
  }, async () => {
    const store = freshStore();
    const local = store.createChat();
    const cloud = store.createChat();
    store.updateChatConfig(cloud.id, { ...OPENROUTER });
    const queue = new RequestQueue(store, providers);
    const first = queue.enqueue(local.id, 'Hi Ollama');
    const second = queue.enqueue(cloud.id, 'Hi OpenRouter');
    await until(() => first.status === 'completed' && second.status === 'completed');
    equal([local.turns[0].content, cloud.turns[0].content], ['local', 'cloud']);
    const description = await providers.describe(OPENROUTER);
    equal([description.models.length, description.account.label, description.account.limitRemaining], [3, 'Laptop', 8.5]);
    assert(openrouter.describeKey(description.account).includes('$8.50 of $10.00 limit left'));
  });
  assert(calls.some(call => call.url === 'http://localhost:11434/api/chat' && !call.auth), 'Ollama requests carry no key.');
  assert(calls.some(call => call.url.endsWith('/chat/completions') && call.auth === 'Bearer sk-or-v1-routed'), 'OpenRouter requests use the saved key.');
});

window.testsDone = (async () => {
  const results = [];
  const list = document.querySelector('#results');
  for (const { name, run } of cases) {
    const row = document.createElement('li');
    try {
      await run();
      row.className = 'pass';
      row.textContent = `PASS — ${name}`;
      results.push({ name, status: 'passed' });
    } catch (error) {
      row.className = 'fail';
      row.textContent = `FAIL — ${name}`;
      const detail = document.createElement('pre');
      detail.textContent = error.stack || error.message;
      row.append(detail);
      results.push({ name, status: 'failed', error: error.message });
    }
    list.append(row);
  }
  const failed = results.filter(result => result.status === 'failed').length;
  const passed = results.length - failed;
  const summary = document.querySelector('#summary');
  summary.className = failed ? 'fail' : 'pass';
  summary.textContent = `${passed} passed · ${failed} failed`;
  document.documentElement.dataset.testStatus = failed ? 'failed' : 'passed';
  return { passed, failed, tests: results };
})();
