# Guanaco: handoff for coding agents

This file is the entry point for an AI assistant arriving with no conversation context. Read it before changing the application. It applies equally to Codex, Claude Code, or another coding assistant.

## Product and constraints

Guanaco is a single-page application that orchestrates conversations with an existing Ollama server. The user creates any number of small request windows, represented by cards. Submitting a prompt immediately starts it when the application queue is idle; otherwise it waits. Opening a card shows its full chat, including pending work. Follow-up messages use the same shared queue.

- All source code, identifiers, code comments, UI text, and project documentation are in English. Communicate with this user in Spanish.
- Application code is exclusively HTML, CSS, and vanilla JavaScript ES modules. Keep it runnable with `python -m http.server`; do not introduce a Node.js server, build pipeline, package dependency, CDN, or external font requirement.
- The browser manages inference serialization. Never rely on Ollama's internal queue to implement Guanaco's ordering.
- The six primary settings are server URL, model selection from the server, `num_ctx`, `num_predict`, system prompt, and the Boolean Think switch. Advanced settings supplement them.
- Global defaults apply when a chat is created. Per-chat overrides are visually distinguished with purple, while global snapshots use teal. Color always has a corresponding text label.
- Global settings support validated JSON import/export, localStorage persistence, and restoring application defaults.

## Start and inspect

```bash
cd /home/v/guanaco
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://localhost:8000`. `python -m http.server` works when `python` resolves to Python 3. No install/build step exists. Opening the HTML through `file://` is unsupported because the application uses module imports and browser storage.

Ollama is a separate existing process at `http://localhost:11434`. Use only the installed small model `hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0` for local integration tests unless the user directs otherwise. Do not download additional models or change the user's Ollama service just to run tests. The verified local instance already allows the frontend origin.

`README.md` explains user workflows. `docs/ollama.md` records official HTTP/CLI references, Linux Mint connection setup, CORS, and model limitations. `docs/validation.md` is the recorded verification run. `prompts/init.md` keeps the original prompt that produced the application; treat it as history, not as a specification to re-execute. `LICENCE.txt` is an MIT licence; do not add per-file licence headers or change its terms.

## Module map

| File | Responsibility |
| --- | --- |
| `index.html` | Static shell, navigation, view containers, dialogs, import input, module entry point. |
| `css/styles.css` | Tokens, layout, forms, status colors, responsive behavior, focus styles, reduced-motion and print rules. |
| `js/app.js` | Composition root, hash routing, shared context, actions, dialogs, model cache, connection status, toasts. |
| `js/core/config.js` | Defaults, validation, immutable snapshots, versioned configuration import/export. |
| `js/core/store.js` | Observable workspace, storage validation, chat operations, persistence and recovery. |
| `js/core/queue.js` | FIFO scheduling, cancellation, retry, history construction, generation lock. |
| `js/core/api.js` | Ollama HTTP requests, NDJSON decoding, transport timeout, error normalization. |
| `js/ui/dom.js` | Safe DOM construction, badges, status helpers, Markdown subset, downloads. |
| `js/ui/config-form.js` | Shared global/per-chat form and model dropdown. |
| `js/ui/orchestrator.js` | Request cards, search/filter, statistics, live queue. |
| `js/ui/chat.js` | Conversation list, streamed turns, thinking blocks, composer, retry/cancel/copy. |
| `js/ui/settings.js` | Global settings, import/export/reset, server diagnostics. |
| `tests/core.test.js` | Browser-native, isolated automated core tests using fake transports. |
| `tests/index.html` | Test harness; exposes `window.testsDone` for automation. |
| `tests/browser.mjs` | Optional Node-based Chromium DevTools test driver; not part of application runtime. |

Views receive a shared context explicitly; application state is not exposed as a window global. A view factory returns `{ element, update, destroy }`, with the board also exposing `focusChat(id)`. Views are created lazily and retained, preserving drafts during navigation; the chat view additionally keeps one draft per conversation in memory. Store notifications are rendered at most once per animation frame, and only the active view updates. Routing uses `#orchestrator`, `#chat`, and `#settings`.

The context is `{ store, queue, toast, confirm, getModels, checkConnection, navigate, openChat, newChat, removeChat, editChatConfig, selectedChatId }`. `toast(message, isError)` and `confirm(title, message, actionLabel)` own the only user notifications and the only destructive confirmation; do not call `alert`/`confirm` or build ad-hoc banners. `getModels(config, force)` caches each server URL's model list for 30 seconds so several forms can populate a dropdown without repeated requests. `selectedChatId` is a mutable field on the context, not persisted state.

`js/ui/config-form.js` returns `{ element, read, refreshModels, fields, destroy }` instead of the view interface, because dialogs and the settings view embed it. `read()` validates and throws; the caller renders the message. A saved model that the server does not list is kept as a `(saved selection)` option so an offline server cannot silently rewrite a configuration.

## State and identifiers

`createStore()` returns a store with `state`, `subscribe(listener)`, `notify()`, `save()`, `setConfig(config)`, `createChat()`, `updateChatConfig(id, configOrNull)`, and `deleteChat(id)`. `createStore({storage})` injects a storage adapter for tests; adapters provide synchronous `getItem` and `setItem`.

```text
state = { config, chats: [], jobs: [], paused: false }
chat  = { id, title, createdAt, configMode, config, turns: [] }
turn  = { id, prompt, content, thinking, status, error, createdAt, metrics }
job   = { id, chatId, turnId, config, status, createdAt }
```

`store.js` also exports `createId(prefix)` (a UUID where available) and `STORAGE_KEYS`. `store.storageError` holds the last load/save failure message.

`configMode` is `global` or `custom`. Turn/job statuses are `queued`, `running`, `completed`, `failed`, `cancelled`, and `interrupted`. A card without turns is displayed as `draft`; draft is a derived UI state, computed with `chatStatus()` in `dom.js` alongside `statusLabel()` and `jobForTurn()`. Dates are ISO strings.

Retries reuse the same turn but append a new job. Therefore `jobForTurn()` must find the **last** matching job; returning the first would show an obsolete attempt's queue status or cancel the wrong job. Completed statistics count successful jobs. A chat title comes from the first prompt, normalized and truncated to 72 characters.

## Queue invariants

`new RequestQueue(store, client = streamChat)` exposes `enqueue(chatId, prompt)`, `retry(chatId, turnId)`, `cancel(jobId)`, `setPaused(paused)`, `position(jobId)` (1-based place among queued jobs), and the `activeJobId` getter. The injected client has `streamChat`'s signature, which is how tests drive the queue without a server. Prompts are trimmed and limited to 1,000,000 characters.

1. Only `RequestQueue` initiates inference. UI components call `enqueue(chatId, prompt)`; they do not call `/api/chat` directly.
2. At most one job is active in a queue instance. `schedule()` uses a microtask; `runNext()` claims the first queued job and holds the active slot through its entire transport lifetime.
3. `cancel()` aborts an active transport but does not immediately free the slot. The next job starts only after cleanup reaches `finally`. A waiting job can be cancelled immediately.
4. Pause prevents dispatch of the next job and allows a running job to finish. Submissions remain accepted while paused.
5. Build conversation history **when the job starts**, after the generation lock is held, using its captured system prompt, earlier completed user/assistant pairs, and the current prompt. Do not include future queued messages, failed/cancelled partial responses, or the model's thinking text. This allows multiple messages in one conversation to be queued safely.
6. Each job captures a frozen configuration at submission. Changing global or chat settings cannot mutate a waiting/running request.
7. Errors terminate their job and release the slot; later work continues. There are no automatic retries.
8. Explicit retry is allowed only for a failed/cancelled/interrupted turn with no pending jobs in that chat and no later non-cancelled turns. This avoids rewriting history already used by later responses.
9. Deleting a chat with pending work is rejected. Cancel its jobs and wait for active cancellation to settle first.

Where available, the Web Locks API serializes inference across same-origin tabs under `guanaco.ollama.generation.v1`. `job.waitingForLock` and `job.cancelling` are transient UI hints. Without Web Locks, serialization is per tab. Locks do not synchronize the workspace, nor coordinate other browser profiles/origins or external Ollama clients. Keep a single editing tab; simultaneous tabs have last-writer-wins localStorage behavior. The app reports external storage changes.

## Configuration rules

`validateConfig(raw)` accepts a partial plain configuration, rejects unknown fields, fills defaults, and returns a fresh validated object. `configSnapshot(raw)` additionally freezes the object and its stop list.

| JavaScript field | Initial value | HTTP mapping |
| --- | --- | --- |
| `serverUrl` | `http://localhost:11434` | Base URL; may include a reverse-proxy path prefix. |
| `model` | `hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0` | `model` |
| `numCtx` | `4096` | `options.num_ctx` |
| `numPredict` | `2048` | `options.num_predict` |
| `systemPrompt` | `You are a helpful assistant.` | Initial `system` message, omitted if empty. |
| `think` | `false` | Boolean `think` |
| `temperature` | `0.7` | `options.temperature` |
| `topP` / `topK` | `0.9` / `40` | `options.top_p` / `options.top_k` |
| `repeatPenalty` | `1.1` | `options.repeat_penalty` |
| `seed` | `-1` | `options.seed` |
| `keepAlive` | `5m` | `keep_alive`; `0` and `-1` become numbers. |
| `timeoutSeconds` | `300` | Browser transport deadline; not sent to Ollama. |
| `format` | `text` | `format: "json"` only for JSON mode. |
| `stop` | `[]` | `options.stop` |

Server URLs require HTTP(S) and cannot contain credentials, query strings, or fragments. Read `config.js` for exact numeric bounds. Keep form constraints consistent with validation; float fields use `step="any"` so valid imported values remain editable. Stop sequences use a JSON-array editor to preserve exact spaces and embedded newlines when importing and resaving settings.

New chats receive a global snapshot. Setting a custom config changes future submissions for that chat only. `updateChatConfig(id, null)` replaces it with a fresh snapshot of the **current** global defaults and sets mode back to `global`. Existing conversations are not live references to global settings.

Exports have `{ schema: "guanaco.configuration", version: 1, exportedAt, config }`. Imports accept this envelope or a plain configuration object, reject files larger than 2 MB, and validate before mutation. Exports include saved global settings only, not unsaved form edits or chat history. Add explicit migrations if changing persisted/exported schemas.

## Persistence and recovery

- `guanaco.config.v1`: saved global configuration.
- `guanaco.workspace.v1`: `{ version: 1, chats, jobs, paused }`.

Terminal transitions persist immediately. Streaming notifications schedule a save at most every 250 ms, and `pagehide` flushes a save. Reloading turns any saved `queued`/`running` work into `interrupted`; it never replays inference automatically. A navigation warning appears if work is pending.

Storage load validates dates, IDs, configuration, statuses, and job references. Malformed data falls back to a usable in-memory app and produces a visible notice. Quota errors do not stop inference; `storageError` makes failed saves visible. Settings are saved separately before the larger workspace. Browser profiles, hostnames, and ports each have their own storage scope. Draft text and the selected conversation are deliberately not persisted; only the view lives outside memory, in the URL hash.

## Transport and rendering

`listModels(config)` calls `GET /api/tags`; `serverVersion(config)` calls `GET /api/version`. These metadata calls do not use the inference queue and cap their deadline at 20 seconds so a wrong URL cannot hang a form for the full `timeoutSeconds`. `streamChat(config, messages, {signal, onChunk})` posts to `/api/chat` and returns the final event's metrics. `onChunk({content, thinking})` supplies deltas.

Do not assume network chunks align with JSON lines or UTF-8 characters. The decoder buffers incomplete lines, accepts CRLF, handles stream error objects even after HTTP 200, requires `done: true`, rejects data sent after the final event, and caps a single unterminated line at 8 MiB. HTTP, parsing, timeout, and user-cancel errors all clean up the reader. Timeouts abort the actual fetch, including stalled streams.

Think is model-dependent: Qwen3 supports a Boolean switch; GPT-OSS requires levels and cannot fully disable reasoning. The UI and guide explain this limitation. The app displays returned thinking separately without inventing or transforming it. The provided small GGUF model can use its entire output budget for reasoning; `done_reason: "length"` is visibly reported and the limit is configurable.

Create DOM through `el()` and text nodes. Never inject user prompts, model output, imported configuration, model names, or server errors through `innerHTML`. The Markdown renderer supports paragraphs, fenced code, headings, lists, inline code, and bold; raw HTML remains literal. No model output is executed. Keep code blocks scrollable and long text wrapped.

Composers submit with Ctrl/⌘+Enter through `submitShortcut()`; keep that binding when adding another text input. Turn metrics are shown as `eval_count`, `total_duration`, and a `done_reason: "length"` warning, and unknown metric fields are simply not displayed.

Preserve focused controls and draft inputs while streaming. Cards are keyed by chat ID, turns by turn ID, and the queue list only rebuilds when its metadata signature changes. Do not rebuild the queue buttons on every token. Think `<details>` expansion survives deltas. Streaming deltas retain the reader's scroll position when they scroll upward; adding a turn scrolls to the latest message. Creating a new card clears the previous board search/filter so the new draft is visible and focusable.

## Extending the application

- **New setting:** update defaults/validation, the shared form, the API mapping if needed, import/export compatibility, and relevant tests/docs together. Preserve snapshot semantics.
- **New view:** add a view module/factory, static section and navigation link, and routing registration in `app.js`. Use injected context and return the standard view interface.
- **New generation feature:** represent it as queued work. Keep scheduling policy out of views and wire protocol details in `api.js`.
- **Different storage:** inject a compatible adapter; an asynchronous IndexedDB adapter requires a deliberate store redesign rather than pretending writes are synchronous.
- **Richer message types/tools:** extend the turn schema and history builder together. Tool calls, image attachments, and model management are not implemented today.
- **Cross-tab editing:** add coordinated ownership or transactional merging before claiming synchronized workspaces. The existing generation lock alone is insufficient.

## Verification

Open `http://localhost:8000/tests/` for 11 browser-native tests. They use injected in-memory storage and mocked transports, so they do not overwrite actual chats or need Ollama. Wait until the page reports completion. Automation can await `window.testsDone`, which resolves `{passed, failed, tests}` and also sets `document.documentElement.dataset.testStatus`. Run the harness when no other tab is holding Guanaco's generation lock.

The optional `tests/browser.mjs` uses a dedicated Chromium debugging profile and Node solely as a DevTools client. It verifies real Ollama CORS/model loading, three queued requests and chat continuation, snapshots, configuration transfer/reset, Think streaming, cancellation/retry, reload persistence, responsive layout, browser exceptions, and the core harness. It reads `GUANACO_TEST_URL` and `GUANACO_DEBUG_URL`, and takes one optional flag:

- no flag: the full suite. It clears Guanaco's keys in that test profile first, then runs the feature and closing checks.
- `--features`: import/export, Think streaming, restoring defaults, and cancellation/retry against the workspace already in that profile.
- `--finish`: reload persistence, board filters, the 390-pixel mobile pass, and the core harness.
- `--inspect` / `--status`: read-only dumps of the current page for debugging; they assert nothing.

README documents the default and `--features` commands only.

The complete DevTools runner passed with exit code 0 on September 19, 2026, against the local Qwen model in Chromium, including all 11 core cases and desktop/390-pixel mobile layouts. It also covers imported stop-string fidelity and creation with active board filters. Screenshots are optional temporary artifacts under `/tmp/guanaco-*.png`; the application does not depend on them. Read `docs/validation.md` for the recorded results and practical scope.

Test-driver detail: reset persisted fixtures using `Page.addScriptToEvaluateOnNewDocument` before reloading. Clearing storage in the old page before navigation is insufficient because its `pagehide` handler saves the old workspace again. The driver disables cache and waits through two animation frames after button actions so assertions inspect the final render.

For future changes, run the checks relevant to the changed behavior. Queue, history, cancellation, storage recovery, and protocol changes need meaningful regression checks. Plain styling changes need visual inspection at desktop and mobile sizes; avoid tests that merely repeat CSS implementation details.
