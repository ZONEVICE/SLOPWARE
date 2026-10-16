/**
 * Transport plumbing shared by every provider module (api.js for Ollama,
 * openrouter.js for OpenRouter). Protocol knowledge stays in those modules.
 */

/**
 * Combine the caller's cancellation signal with a deadline. The returned
 * signal aborts the real fetch, including a stalled stream, and `timedOut`
 * tells a deadline apart from a user cancellation afterwards.
 */
export function abortScope(parentSignal, timeoutSeconds) {
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
