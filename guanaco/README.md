# Guanaco

> **This software was generated 100% using artificial intelligence** — specifically Codex + GPT-6 Astra, Ultra effort — on September 19, 2026. No skills were used during generation. The initial prompt used to create this application can be found in [`prompts/init.md`](prompts/init.md). Post-creation adjustments draw on both Codex GPT-6 Astra and Claude Code Opus 5, and on Claude Code + Opus 5.5, Max effort, which added the Light, Dark, and Dark OLED themes on October 10, 2026, from the second prompt in the same file. Claude Code + Opus 5.5 also added the OpenRouter provider on October 16, 2026, from the third prompt there.

A browser-based workspace for queued Ollama and OpenRouter conversations. Create as many prompt cards as you need, watch replies stream, and open any card as a full conversation. One application-managed FIFO queue serves every card and chat, whichever provider it uses.

The application uses only HTML, CSS, and JavaScript ES modules. There are no dependencies to install, no build step, and no Node.js server.

## Start

From the project directory:

```bash
cd /home/v/guanaco
python -m http.server 8000 --bind 127.0.0.1
```

If your system exposes Python as `python3`, use `python3 -m http.server 8000 --bind 127.0.0.1` instead. Open [http://localhost:8000](http://localhost:8000). Serve the directory over HTTP; opening `index.html` as a `file://` URL does not provide the expected module and browser-storage environment.

An existing Ollama server must be reachable from your browser. The initial server address is `http://localhost:11434`, and the initial model is `hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0`. Select an installed model in Configuration if you use a different server.

To use cloud models instead, or alongside, choose OpenRouter as the provider and save an OpenRouter API key; see [OpenRouter](#openrouter). It needs no local server beyond the static one above.

## Three views

1. **Orchestrator:** create a prompt card, type a message, and submit it. An idle queue starts it immediately; later submissions wait their turn. Cards show request progress and a response preview. Open a card before, during, or after generation to see its full conversation.
2. **Chat:** continue any conversation using the same queue. A conversation's earlier response is available before its next queued turn is sent. Switching views does not stop generation.
3. **Configuration:** choose the theme, choose the provider (Ollama or OpenRouter), set the server URL, select from the provider's model list, set context and response-token limits, edit the system prompt, and enable or disable Think. Advanced Configuration exposes temperature, Top P, Top K, repeat penalty, seed, model keep-alive, request timeout, output format, and stop sequences.

Each new card receives a snapshot of the saved global configuration. Later global edits apply to future cards. Use a card's configuration button to customize that conversation, including its provider. Global cards use teal accents; custom cards use purple accents, with text labels as well as color. Conversations that use OpenRouter carry a neutral *OpenRouter* badge.

## OpenRouter

[OpenRouter](https://openrouter.ai) serves hundreds of hosted models through one API. Guanaco calls it straight from the browser; OpenRouter accepts requests from web pages, so no proxy or backend is involved.

1. Create a key at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys), ideally with a credit limit.
2. In Configuration → **OpenRouter API key**, paste it and choose **Save key**. Guanaco checks the key and shows its label, spending, and remaining free-model requests. Leave **Remember on this device** off to forget the key when the tab closes.
3. Set **Provider** to OpenRouter in Global defaults, or in one conversation's settings, and choose a model. The list shows prices per million tokens and context sizes; filter it by name or show free models only.

The key is stored apart from the configuration: exports, imports, conversations, and queued jobs never contain it. The sidebar shows whether OpenRouter is connected, has no key, or rejected the key.

OpenRouter fails in more ways than a local server: missing credits, free-model rate limits, providers that are down or rate-limited upstream, privacy settings that exclude every provider of a model, and errors that arrive halfway through an answer. Each failure is shown on the turn in plain words, with what to do next, OpenRouter's own message, and the generation id when there is one. Retry is always explicit. [The OpenRouter guide](docs/openrouter.md) lists every case, the settings mapping, and how Think works there.

## Themes

Configuration opens with an Appearance section offering three themes:

- **Light:** bright, soft surfaces. The default.
- **Dark:** dimmed, softly tinted surfaces and off-white text for low light.
- **Dark OLED:** absolute black backgrounds and pure white text. Color remains only on actions and status labels, and OLED screens can switch off black pixels.

A theme applies as soon as you select it, and this browser remembers it. Guanaco applies the saved theme before the page first appears, so reopening it at night does not flash a light page. On mobile browsers that support it, the browser toolbar takes the theme's background color. Printing always uses the light palette.

The theme is a display preference of the current browser, separate from the configuration: it is not included in configuration exports or imports, and Restore default settings leaves it unchanged. Adding another theme takes one palette block in `css/styles.css` and one entry in `js/ui/theme.js`; see [AGENTS.md](AGENTS.md).

## Queue and recovery

Only one inference request runs at a time in a Guanaco workspace. Waiting work stays in the application until it reaches the front of the queue. Errors release the active slot so other conversations can continue. Request configuration is captured at submission, so later edits do not change work already queued. Pause prevents the next request from starting; it allows the current request to finish. Cancel can remove a waiting request or abort an active one.

Keep the tab open while processing requests. After a reload, unfinished requests are interrupted and must be retried explicitly; Guanaco does not silently replay them. Retry is available for a conversation's latest failed, cancelled, or interrupted turn when it has no pending work. Only completed earlier turns contribute to subsequent conversation context. Browser cancellation closes the client request, while the Ollama server controls how promptly generation stops.

On browsers with the Web Locks API, Guanaco also serializes inference across its tabs on the same origin. Without Web Locks, serialization applies within each tab. Separate browser profiles, different origins, and other Ollama clients have their own queues. Tabs do not merge their workspace edits: use one editing tab to avoid overwriting saved conversations with an older tab's copy. [Web Locks browser documentation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)

## Save and transfer settings

Saved global settings use the `guanaco.config.v1` localStorage key. Conversation data uses `guanaco.workspace.v1`, the chosen theme uses `guanaco.theme.v1`, and a remembered OpenRouter key uses `guanaco.openrouter.key.v1` (a key that is not remembered uses the same name in `sessionStorage`). Storage belongs to the current browser profile and origin; using another hostname or port creates a separate storage scope. Browser storage is not encrypted and may be cleared by browser settings.

Export downloads the saved global configuration as JSON, including the provider but never the OpenRouter key. Import validates a configuration before applying it. It accepts Guanaco's versioned export and a plain configuration object; unknown fields, unsupported versions, and invalid values are rejected. An import changes global defaults for future chats. Configuration exports do not include conversation history.

Restore defaults resets global configuration to the application's initial values, including the Ollama provider. Existing conversations keep their snapshots, and the saved OpenRouter key stays until you forget it.

## Privacy

**Chats are not confined entirely to the browser, and Guanaco cannot guarantee "100% privacy."** The implementation was checked for storage and network behavior:

- Saved conversations and settings use browser `localStorage` as plain JSON, without application-level encryption. Scripts on the same origin or someone with access to your browser profile may access them.
- Each request sends the system prompt, current message, and previous completed conversation turns to the configured provider for inference: your Ollama server, or OpenRouter. The Python server only serves static files.
- With OpenRouter, that content leaves your computer and is processed by OpenRouter and by the company hosting the chosen model, under their data policies. The OpenRouter key is stored unencrypted in browser storage, like everything else.
- Guanaco includes no analytics, trackers, third-party scripts, or automatic cloud synchronization. Remote servers or cloud models process conversation content outside your computer.

With Ollama and a downloaded model running locally, inference can stay on your computer. [Ollama states that it does not receive prompts from local runs](https://docs.ollama.com/faq#does-ollama-send-my-prompts-and-answers-back-to-ollamacom). Privacy still depends on your browser, device, and server configuration.

## Verification

With the Python static server running, open [http://localhost:8000/tests/](http://localhost:8000/tests/). This browser-native suite uses mocked Ollama and OpenRouter responses and injected in-memory storage. It requires neither a model, an OpenRouter key, nor Node.js, and it cannot overwrite your saved Guanaco workspace or key.

Confirmed in Chromium: all 19 isolated core tests pass. Six of them cover OpenRouter: provider validation, the SSE stream and settings mapping, HTTP errors, mid-stream and network failures, key storage, and routing each conversation to its provider. Live browser checks against the installed `hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0` model also verified three requests completing through the shared FIFO queue, opening a queued conversation, continuing its history, global and custom configuration snapshots, pause and queued cancellation, persistence after reload, all three views at a 390-pixel mobile width, and choosing a theme that is saved and applied before the page appears after a reload.

An optional DevTools runner automates the browser checks. Keep the Python server and local Ollama instance running, then launch a dedicated Chromium profile in another terminal:

```bash
chromium --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=9228 \
  --user-data-dir=/tmp/guanaco-browser-profile about:blank
```

From the Guanaco directory, run:

```bash
node tests/browser.mjs
```

Node.js is only the DevTools test driver; it does not serve the application. The optional driver requires a Node.js runtime with built-in `fetch` and `WebSocket`. It connects to the dedicated Chromium instance above and clears only the `guanaco.config.v1`, `guanaco.workspace.v1`, and `guanaco.theme.v1` keys in that test profile before its full smoke run. Live requests target `http://localhost:11434` and use only the supplied Qwen model. Screenshots are written to `/tmp/guanaco-*.png`.

To rerun the extended import/export, Think, restoration, and cancellation/retry scenarios against the existing test workspace:

```bash
node tests/browser.mjs --features
```

The extended import/export, real Think streaming, restoration, and active cancellation/retry checks also passed. The runner does not use OpenRouter. With OpenRouter, the live catalogue, the key check against the real API, and every error path were verified; a real streamed answer needs your key and was not run. See [the verification record](docs/validation.md) for details. To change the frontend or DevTools address, set `GUANACO_TEST_URL` or `GUANACO_DEBUG_URL` respectively. These variables do not change the Ollama test model.

## Project layout

```text
index.html        Single-page shell and navigation
css/              Responsive presentation and theme palettes
js/app.js         Application wiring and user actions
js/core/          Configuration, storage, queue, key storage, and the Ollama and OpenRouter transports
js/ui/            Reusable forms, themes, and view rendering
tests/            Browser-oriented verification
docs/ollama.md    HTTP/CLI integration and connectivity guidance
docs/openrouter.md  OpenRouter setup, settings mapping, and error guide
AGENTS.md         Architecture and maintenance guide for future agents
version.txt       Current application version (Semantic Versioning 2.0.0)
```

Core modules own data and policies; UI modules render them and dispatch actions. Future features should extend those boundaries instead of adding direct API calls in views. In particular, every inference request must pass through the queue.

`version.txt` holds the application's current version as a single [Semantic Versioning 2.0.0](https://semver.org/) string, for example `1.0.0`. Bump it when you release a notable change.

See [the Ollama integration guide](docs/ollama.md) for endpoint details, CLI examples, Think support, browser CORS setup, remote URLs, and troubleshooting, and [the OpenRouter guide](docs/openrouter.md) for the cloud provider. See [AGENTS.md](AGENTS.md) before extending the application.
