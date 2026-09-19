# Ollama integration guide

Guanaco talks directly from the browser to an existing Ollama server. Python only serves the static application files. The browser owns the queue, conversation history, and settings; Ollama owns inference. No Ollama SDK, Node.js process, model download, or service reconfiguration is required by the application.

The references below were reviewed on September 18, 2026. Installed Ollama versions and individual models may support different features.

## HTTP contract

| Request | Guanaco use | Official reference |
| --- | --- | --- |
| `GET /api/tags` | Populate the model dropdown from `models[].name`. | [List models](https://docs.ollama.com/api/tags) |
| `GET /api/version` | Report the server version during connection checks. | [Get version](https://docs.ollama.com/api-reference/get-version) |
| `POST /api/chat` | Submit the system message and conversation history; consume the next assistant reply. | [Chat API](https://docs.ollama.com/api/chat) |

The server URL is a base address, such as `http://localhost:11434`. Guanaco appends the endpoint path. For a reverse proxy, a path prefix is allowed. Model names must match names available on that server.

The chat body carries `model`, `messages`, `stream`, `think`, `keep_alive`, and `options`. The system prompt becomes a message with role `system`; user and assistant messages supply the history. Generation parameters belong under `options`. JSON output additionally sets `format` to `json`. The model's response text arrives in `message.content`. A final response contains `done: true` and may include generation statistics. [Chat API](https://docs.ollama.com/api/chat)

This standalone diagnostic request uses the model selected for this project's local tests:

```bash
curl --no-buffer http://localhost:11434/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0",
    "messages": [
      {"role": "system", "content": "Respond briefly in English."},
      {"role": "user", "content": "Name two colors."}
    ],
    "stream": true,
    "think": false,
    "keep_alive": "5m",
    "options": {"num_ctx": 2048, "num_predict": 64}
  }'
```

This request bypasses Guanaco's queue. Run it when checking Ollama independently.

## Streaming and failures

Ollama streams newline-delimited JSON (NDJSON); a network chunk can contain a partial line or multiple lines. Guanaco buffers incomplete lines, decodes UTF-8 incrementally, and accumulates response fragments. A stream only succeeds after a completion object with `done: true`; a disconnected stream is not silently accepted as complete. [Streaming](https://docs.ollama.com/api/streaming)

An HTTP error can include an `error` property. A stream can also emit an error object after an HTTP 200 response has already started. Both paths must fail the job and release its place in the queue. Typical cases include a malformed request (400), unavailable model (404), rate limits (429), and server failures (500/502). [Errors](https://docs.ollama.com/api/errors)

Guanaco's timeout is a browser-side request limit. Cancellation aborts the browser request; server cancellation timing remains Ollama's responsibility. Keep the app open while its queue is running. A reload marks unfinished work as interrupted and requires an explicit retry.

## Generation settings

| Setting | Effect |
| --- | --- |
| `num_ctx` | Context window used by the model. |
| `num_predict` | Generated-token limit; `-1` requests no fixed token cap. |
| `temperature` | Adjusts sampling randomness. |
| `top_k` / `top_p` | Restrict candidate-token sampling. |
| `repeat_penalty` | Adjusts repeated-token penalties. |
| `seed` | Sets the sampling seed. |
| `stop` | Strings that end generation when encountered. |

These are runtime options. Guanaco explicitly sends its saved defaults instead of relying on model or server defaults. A fixed seed does not guarantee identical results across different model builds, hardware, or server versions. [Modelfile parameters](https://docs.ollama.com/modelfile#valid-parameters-and-values)

Larger context windows consume more memory; the available context also depends on the model and server. Guanaco retains the conversation locally and sends its usable history, but does not summarize it or calculate exact token counts. The server may truncate context when history exceeds its limits. [Context length](https://docs.ollama.com/context-length)

`keep_alive` controls how long a model stays loaded after a request. Duration strings such as `5m` are supported; `0` asks Ollama to unload after the response. It does not control Guanaco's queue or timeout. [Ollama FAQ](https://docs.ollama.com/faq#how-do-i-keep-a-model-loaded-in-memory-or-make-it-unload-immediately)

JSON mode asks Ollama for JSON output. Include the expected data structure in your prompt. Guanaco offers text or JSON mode; it does not provide a JSON-schema editor or automatically execute generated output. [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs)

## Thinking

Guanaco's Think switch sends a Boolean `think` value. Compatible models can emit `message.thinking` separately from `message.content`; the interface keeps that output in a separate collapsible section. The installed model and its template must support the requested behavior.

The switch is not universal: some models reject unsupported thinking settings; GPT-OSS uses `low`, `medium`, or `high` instead of a Boolean and cannot fully disable thinking. Guanaco currently implements the requested Boolean switch, not model-specific thinking levels. [Thinking capability](https://docs.ollama.com/capabilities/thinking)

## Useful CLI commands

```bash
# Inspect installed and loaded models.
ollama ls
ollama ps

# Chat with the already-installed test model.
ollama run hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0

# Inspect its template and built-in parameters.
ollama show --modelfile hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0

# Start a server manually only when a service is not already serving it.
ollama serve
```

`ollama pull MODEL` downloads a model; `ollama stop MODEL` unloads a running model. Guanaco does neither automatically. [CLI reference](https://docs.ollama.com/cli), [Modelfile inspection](https://docs.ollama.com/modelfile)

Inside an interactive CLI session, examples include:

```text
/set parameter num_ctx 2048
/set parameter num_predict 128
/set think
/set nothink
```

The first commands set generation parameters; the last two toggle thinking for compatible models. For a single invocation, use `ollama run MODEL --think=false "Your prompt"`. These CLI settings do not change Guanaco's saved configuration. [Context configuration](https://docs.ollama.com/faq#how-can-i-specify-the-context-window-size), [Thinking CLI options](https://docs.ollama.com/capabilities/thinking#cli-quick-reference)

## Browser access on Linux Mint

First try the application at `http://localhost:8000` and Ollama at `http://localhost:11434`. The browser makes cross-origin requests because the ports differ. If command-line requests succeed but browser requests fail, inspect the browser console and Ollama logs for origin restrictions.

For a systemd installation, an administrator can add the exact frontend origins using:

```bash
sudo systemctl edit ollama.service
```

Add this override, adapting the origins to your actual frontend addresses:

```ini
[Service]
Environment="OLLAMA_ORIGINS=http://localhost:8000,http://127.0.0.1:8000"
```

Then apply it:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama.service
```

`OLLAMA_ORIGINS` controls accepted browser origins. `OLLAMA_HOST` controls where Ollama listens; network clients need a reachable listening address and firewall configuration. They are separate settings. Guanaco cannot change either from the browser. [Ollama FAQ](https://docs.ollama.com/faq)

Inspect service status and recent logs with:

```bash
systemctl status ollama.service
journalctl -u ollama.service -n 100 --no-pager
```

These instructions are for an existing Linux service. Guanaco's installation does not run administrator commands or restart Ollama. [Linux service documentation](https://docs.ollama.com/linux)

## External servers and browser limitations

For a remote server, enter its reachable HTTP(S) base URL. It must permit the frontend's origin and its JSON request preflight. HTTPS frontends should use HTTPS remote APIs; browsers can block insecure mixed-content requests. A generic fetch failure cannot reliably distinguish these causes, so compare browser console output with a direct `curl` request. [Browser CORS behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS), [Mixed-content restrictions](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)

The standard local Ollama API does not require authentication. Direct Ollama cloud API access requires authorization credentials. Guanaco does not provide API-key fields or custom authentication headers, so configure any external authentication at your infrastructure boundary. [Ollama authentication](https://docs.ollama.com/api/authentication)

The application can reach only what the browser can reach. Python's static file server does not proxy API requests or bypass CORS. Prompts and settings stay in browser storage and are sent to the configured Ollama address when you submit work; using a remote address therefore sends conversation content to that host.
