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

## Theme verification

Re-verified on October 10, 2026, after the Light, Dark, and Dark OLED themes were added, using the same Chromium setup and local model:

- The complete `node tests/browser.mjs` run finished with exit code 0, including the new theme checks and all 13 core tests. Case 12 covers theme validation, persistence, unknown saved values, and blocked storage. Case 13 checks that `THEMES`, the stylesheet palettes, and the pre-paint script agree. Removing one token from a palette, or adding a palette without registering it, made case 13 fail and name the problem.
- Choosing Dark OLED applied and saved it at once. After a reload, the theme was already set on `<html>` when `<body>` was created, before any module ran, and `theme-color` matched the page background. With the pre-paint script removed, the same probe found no theme at that moment, so it detects a light flash.
- Light keeps the original design. Computed colors of every element in a fixture workspace (every request status, both configuration modes, dialogs, toasts, thinking, code, and errors) were compared with the previous version at desktop and 390-pixel widths. About 95% of the compared values were identical, and most of the rest moved by 8 units per channel or less. The largest moves, up to 20 units, affected a few small secondary text shades that were merged into shared tokens. Side-by-side screenshots looked identical.
- Contrast was measured for the 831 visible text runs in that fixture. Dark has a minimum of 4.5:1 and a median of 7.5:1. Dark OLED has a minimum of 5.4:1 and a median of 11.2:1. The Light palette is unchanged, including its lighter secondary text.
- All three views and both dialogs were inspected at desktop and 390-pixel widths in each theme, with no horizontal overflow and no browser exceptions.

The runner's cancellation step now waits for the Stop generation button to render before clicking it. Before, it could click during the frame between dispatch and the next render, and one run failed that way.

## OpenRouter verification

Verified on October 16, 2026, after the OpenRouter provider was added, in Chromium against the live OpenRouter API, without an API key:

- The complete `node tests/browser.mjs` run finished with exit code 0, including all 19 core tests. The Ollama scenarios above still pass unchanged against the local Qwen model; the runner itself does not use OpenRouter.
- Six new core cases cover OpenRouter with a mocked `fetch`: provider validation and defaults for older configurations; byte-by-byte fragmented SSE with keep-alive comments, CRLF, reasoning, usage, and `[DONE]`, and the request body for each setting (including Think on, Think off, and a model that must reason); 13 HTTP error shapes (401, 402, 403 budget and moderation, 404 privacy, 400 context and model, 429 free and upstream, 502, 503, a Cloudflare 524 HTML page, 500); mid-stream error events with and without partial output, a stream closed early, malformed data, a JSON error with HTTP 200, a network failure, cancellation, and timeout; key normalization, session versus device storage, blocked storage, and its absence from configurations and exports; and one queue running an Ollama conversation and an OpenRouter conversation, each through its own provider.
- Live from the page at `http://localhost:8000`: the public catalogue loaded 467 models (19 free) into the dropdown; the filter and Free only narrowed it; the selected model showed its name, context, price, and reasoning support. A cross-origin `GET /key` and `POST /chat/completions` with an `Authorization` header passed the CORS preflight, and an obviously invalid placeholder key produced OpenRouter's real 401 body, explained as an unrecognised key.
- Through the visible interface: saving OpenRouter as the global provider without a key turned the sidebar status amber (*OpenRouter · no API key*), the form showed the missing-key notice, and a submitted prompt failed at once with the missing-key explanation on the card and in the chat, without a request. Saving an empty key showed its error. The new settings section was checked in Light and Dark and at a 375-pixel width without horizontal overflow, and no console errors appeared.
- With the page's `fetch` replaced for the chat and key endpoints only (nothing sent), a prompt submitted from a card streamed into the chat with its reasoning in the thinking block, Markdown rendered, and the metrics line *18 output tokens (7 reasoning) · 1.2 s · via Google AI Studio · no cost*. **Check key** showed the label, the limit left, the spending, and the free-model requests left today. At start-up, before that replacement, the real API rejected the placeholder key and the sidebar showed *OpenRouter key rejected* in red.
- Not verified: a real streamed answer, key check, and cost report with a funded or free-tier key, which need the user's own key.

## Scope

The application runs entirely in the browser; Python serves unchanged static files. Node is optional and used only by the DevTools runner. The core test page requires no Node installation.

Live remote servers, authentication proxies, other browsers, and other model families were not integration-tested. Remote URLs are supported through the same HTTP transport, subject to browser CORS, mixed-content, and network rules documented in `ollama.md`. Large histories remain subject to browser storage capacity and the model's context limit. Multiple tabs serialize generation where Web Locks is available but do not merge workspace edits.
