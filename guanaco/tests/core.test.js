/**
 * Open /tests/ using the same static HTTP server as the app. This suite uses
 * only browser APIs and injected memory storage; it cannot overwrite a user's
 * settings or conversations. Automation may await window.testsDone.
 */
import { DEFAULT_CONFIG, validateConfig, parseConfigImport, exportConfig } from '../js/core/config.js';
import { createStore, STORAGE_KEYS } from '../js/core/store.js';
import { RequestQueue } from '../js/core/queue.js';
import { listModels, streamChat } from '../js/core/api.js';

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
