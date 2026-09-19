# Verification record

Verified on September 19, 2026 using the application's Python static server, Chromium, and the existing local Ollama instance. The only model used for live requests was `hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0`.

The complete `node tests/browser.mjs` run finished successfully with exit code 0, including every integration scenario and all 11 core tests.

## Automated core verification

All 11 browser-native test cases passed in Chromium:

1. Configuration validation and versioned JSON round trips.
2. Independent global, chat, and queued-job configuration snapshots.
3. FIFO serialization and same-chat history construction at dispatch.
4. Queue pause, cancellation, retry, and history protection.
5. Retaining the active queue slot until cancelled transport cleanup settles.
6. Continuing after failed requests and excluding partial failed history.
7. Reload recovery without automatic inference replay.
8. Corrupt storage and quota failure handling.
9. Fragmented UTF-8/NDJSON, thinking deltas, metrics, and HTTP option mapping.
10. Stream errors, malformed JSON, HTTP errors, and missing completion events.
11. Actual transport abort on timeout and user cancellation.

The harness is available at `/tests/`. It uses injected memory storage and mocked responses; no model is required for these cases.

## Browser integration verification

The Chromium DevTools runner exercised the application through its visible forms, navigation, and buttons:

- Connected from the browser to the real local Ollama API, including CORS and installed-model discovery.
- Submitted requests in two windows, opened a queued chat, and submitted a follow-up while another conversation was generating. Three real requests completed in sequence.
- Applied per-chat settings, preserved other conversations, changed global defaults, and verified that only newly created chats inherited them.
- Paused dispatch, cancelled queued work, resumed, and reloaded with saved conversations and the custom-configuration marker intact.
- Imported configuration JSON, resaved arbitrary valid decimal values, rejected malformed JSON without changing settings, and checked the versioned export blob.
- Preserved exact whitespace and embedded newlines in imported stop sequences after editing and saving the form.
- Enabled Think for a real Qwen request and received/displayed a separate thinking stream.
- Restored global defaults while preserving existing snapshots and returned a chat to current global defaults.
- Exercised active cancellation and retry with a controlled browser response.
- Checked desktop presentation and all three views at a 390-pixel mobile width.
- Created a new visible, focused request window with an existing search and status filter active.

Application browser sessions completed without uncaught JavaScript exceptions. The reusable DevTools runner waits for document/render completion, bypasses the browser cache, and resets fixture storage at the new document's start so the previous page's shutdown save cannot restore old test data.

## Scope

The application runs entirely in the browser; Python serves unchanged static files. Node is optional and used only by the DevTools runner. The core test page requires no Node installation.

Live remote servers, authentication proxies, other browsers, and other model families were not integration-tested. Remote URLs are supported through the same HTTP transport, subject to browser CORS, mixed-content, and network rules documented in `ollama.md`. Large histories remain subject to browser storage capacity and the model's context limit. Multiple tabs serialize generation where Web Locks is available but do not merge workspace edits.
