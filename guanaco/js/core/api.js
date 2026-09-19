/**
 * The only module that knows Ollama's HTTP protocol. It has no DOM or storage
 * dependencies so queue policy and presentation can evolve independently.
 */

function endpoint(config, path) {
  return `${config.serverUrl.replace(/\/+$/, '')}${path}`;
}

function abortScope(parentSignal, timeoutSeconds) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('The request timed out.', 'TimeoutError'));
  }, timeoutSeconds * 1000);
  return {
    signal: controller.signal,
    controller,
    get timedOut() { return timedOut; },
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function explainError(error, scope, serverUrl) {
  if (scope.timedOut) return new Error('Ollama request timed out. Increase the request timeout or use a smaller model.');
  if (scope.signal.aborted) return new DOMException('Request cancelled.', 'AbortError');
  if (error instanceof TypeError) {
    return new Error(`Cannot reach Ollama at ${serverUrl}. Check that Ollama is running, the URL is correct, and OLLAMA_ORIGINS permits this page's origin. An HTTPS page cannot connect to an HTTP server unless the browser allows it.`);
  }
  return error;
}

async function checkResponse(response) {
  if (response.ok) return;
  let detail = '';
  try {
    const body = await response.text();
    try { detail = JSON.parse(body).error || body; } catch { detail = body; }
  } catch { /* The HTTP status remains useful when the body is unavailable. */ }
  throw new Error(`Ollama returned HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 1000)}` : '.'}`);
}

async function getJSON(config, path, { signal } = {}) {
  const scope = abortScope(signal, Math.min(config.timeoutSeconds || 300, 20));
  try {
    const response = await fetch(endpoint(config, path), { signal: scope.signal, cache: 'no-store' });
    await checkResponse(response);
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Ollama returned an invalid JSON response.');
    }
    if (data.error) throw new Error(String(data.error));
    return data;
  } catch (error) {
    throw explainError(error, scope, config.serverUrl);
  } finally { scope.cleanup(); }
}

export async function listModels(config, options = {}) {
  const data = await getJSON(config, '/api/tags', options);
  if (!Array.isArray(data.models)) throw new Error('Ollama returned an invalid model list.');
  return data.models.filter(model => model && typeof model.name === 'string');
}

export async function serverVersion(config, options = {}) {
  const data = await getJSON(config, '/api/version', options);
  if (typeof data.version !== 'string') throw new Error('Ollama returned an invalid version response.');
  return data.version;
}

/**
 * Parse NDJSON incrementally: UTF-8 characters and lines may cross network
 * chunks. A successful HTTP response is insufficient; done:true is required.
 * onChunk receives {content, thinking} deltas; the returned object is the final
 * event containing Ollama's duration and token-count metrics.
 */
export async function streamChat(config, messages, { signal, onChunk = () => {} } = {}) {
  const scope = abortScope(signal, config.timeoutSeconds);
  let reader;
  let finalEvent = null;
  try {
    const body = {
      model: config.model,
      messages,
      stream: true,
      think: config.think,
      keep_alive: config.keepAlive === '-1' ? -1 : config.keepAlive === '0' ? 0 : config.keepAlive,
      options: {
        num_ctx: config.numCtx,
        num_predict: config.numPredict,
        temperature: config.temperature,
        top_p: config.topP,
        top_k: config.topK,
        repeat_penalty: config.repeatPenalty,
        seed: config.seed,
        stop: config.stop,
      },
    };
    if (config.format === 'json') body.format = 'json';
    const response = await fetch(endpoint(config, '/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: scope.signal,
    });
    await checkResponse(response);
    if (!response.body) throw new Error('This browser did not provide a response stream.');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const consume = line => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); }
      catch { throw new Error('Ollama returned malformed JSON in its response stream.'); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new Error('Ollama returned an invalid stream event.');
      }
      if (event.error) throw new Error(String(event.error));
      if (finalEvent) throw new Error('Ollama sent data after its final response event.');
      const content = event.message?.content ?? '';
      const thinking = event.message?.thinking ?? '';
      if (typeof content !== 'string' || typeof thinking !== 'string') {
        throw new Error('Ollama returned invalid message content.');
      }
      if (content || thinking) onChunk({ content, thinking });
      if (event.done === true) finalEvent = event;
    };
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) break;
      if (buffer.length > 8 * 1024 * 1024) throw new Error('Ollama stream event exceeded the maximum supported size.');
    }
    if (buffer.trim()) consume(buffer);
    if (!finalEvent) throw new Error('Ollama closed the response before completion. You can retry this turn.');
    return finalEvent;
  } catch (error) {
    // Do not leave a reader/socket alive after a parser or callback failure.
    scope.controller.abort();
    throw explainError(error, { timedOut: scope.timedOut, signal: signal || { aborted: false } }, config.serverUrl);
  } finally {
    if (reader) {
      try { await reader.cancel(); } catch { /* Aborted fetch streams can reject cancellation. */ }
      reader.releaseLock();
    }
    scope.cleanup();
  }
}
