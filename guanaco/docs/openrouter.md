# OpenRouter integration guide

Guanaco can send a conversation to [OpenRouter](https://openrouter.ai) instead of an Ollama server. OpenRouter is a cloud API that serves hundreds of hosted models through one OpenAI-compatible endpoint. The browser talks to `https://openrouter.ai/api/v1` directly: OpenRouter allows requests from any web page (CORS), so Guanaco needs no proxy, no Node.js or Python backend, and no operating-system access. Python still only serves the static files.

The provider is part of the configuration. Global defaults can use one provider and a single conversation another, so local Ollama chats and OpenRouter chats can share the same queue.

The references below were reviewed on October 16, 2026. OpenRouter changes models and limits often; the model list in Configuration always comes from the live catalogue.

## Set it up

1. Create an API key at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys). Give it a credit limit: a limit caps what a leaked key could spend.
2. In Configuration → **OpenRouter API key**, paste the key and choose **Save key**. Guanaco checks it with OpenRouter at once and shows the key's label, spending, and free-model allowance.
3. In **Global defaults** (or a conversation's gear button), set **Provider** to *OpenRouter · cloud API*, pick a model, and save.

The model dropdown lists every chat model with its price per million tokens and context size. Type in the filter (for example `gemma` or `:free`) or tick **Free only** to narrow it. Selecting a model shows its full name, context window, price, and whether it reasons. OpenRouter has no sensible default model, so Guanaco asks you to choose one.

## The API key

The key is a per-browser setting, separate from the configuration:

- It is never part of chat or queue snapshots, the saved workspace, or configuration exports. Sharing an exported JSON never shares the key.
- With **Remember on this device** off, it lives in `sessionStorage` and disappears when the tab closes. With it on, it is kept in `localStorage` under `guanaco.openrouter.key.v1` until you choose **Forget key**. Only one of the two holds it at a time.
- Neither storage is encrypted. Scripts on the same origin and anyone with access to the browser profile can read it. When the browser refuses storage, the key stays in memory until the page reloads.
- Guanaco reads the key when a request starts. A key saved after a message was queued is used for it.
- Guanaco removes a pasted `Bearer ` prefix and surrounding whitespace, rejects characters a key cannot contain, and warns when a key does not start with `sk-or-` (OpenAI, Anthropic, and other vendors' keys do not work on OpenRouter).

## HTTP contract

| Request | Guanaco use | Official reference |
| --- | --- | --- |
| `GET /api/v1/models` | Populate the model dropdown. Public; no key needed. | [Models](https://openrouter.ai/docs/api-reference/models/get-models) |
| `GET /api/v1/key` | Validate a key and show its limits during connection checks. | [Limits](https://openrouter.ai/docs/api-reference/limits) |
| `POST /api/v1/chat/completions` | Stream the next assistant reply. | [Streaming](https://openrouter.ai/docs/api-reference/streaming) |

Requests carry `Authorization: Bearer <key>` and `X-Title: Guanaco`, so OpenRouter's activity page names the application.

## Settings mapping

| Guanaco setting | OpenRouter request |
| --- | --- |
| Model | `model` |
| System prompt and history | `messages`, exactly as for Ollama |
| Response limit | `max_tokens` when above 0; -1 and -2 omit it, leaving the limit to the model. It includes reasoning tokens, and OpenRouter reserves credit for it before the request starts. |
| Temperature | `temperature` (OpenRouter accepts 0 to 2; Guanaco refuses higher values for this provider) |
| Top P | `top_p` |
| Top K | `top_k` when above 0 |
| Repeat penalty | `repetition_penalty` (0 to 2) |
| Random seed | `seed` when 0 or above |
| Stop sequences | `stop` when not empty |
| Response format JSON | `response_format: {"type": "json_object"}` |
| Think | `reasoning` (below) |
| Request timeout | Browser deadline; aborting also stops billing on providers that support cancellation |
| Context window, Keep model loaded, Ollama server URL | Ollama-only. Hidden for OpenRouter and kept for when you switch back. |

Providers apply their own defaults to omitted parameters. A provider may ignore a parameter its model does not support.

### Think

OpenRouter's catalogue says whether each model can reason and whether it must. Guanaco uses it:

- **Think on** sends `reasoning: {enabled: true}` unless the catalogue says the model cannot reason.
- **Think off** sends `reasoning: {effort: "none"}` only to models that can switch reasoning off. Models that always reason reject that value, so they receive no `reasoning` field and their reasoning still streams into the thinking section.

Streamed reasoning arrives as `delta.reasoning` (or readable `reasoning_details`) and is shown in the separate thinking block, like Ollama's `thinking`. Encrypted reasoning has no readable text and is not shown.

## Streaming

The reply is a Server-Sent Events stream. Guanaco decodes it incrementally, so UTF-8 characters and lines may cross network chunks. It ignores keep-alive comments such as `: OPENROUTER PROCESSING`, treats every `data:` line as one JSON event, accepts CRLF, and caps one line at 8 MiB.

A stream succeeds only after `data: [DONE]` or a `finish_reason`. The usage chunk just before `[DONE]` provides the token counts and the cost. Guanaco reports them with Ollama's metric names, so each OpenRouter turn shows output tokens, how many were reasoning, the duration, the provider that served it, and the cost. A `finish_reason` of `length` shows *Response limit reached*; `content_filter` shows that the provider's filter stopped the answer.

## Errors

OpenRouter fails in many ways, and some failures arrive after an HTTP 200, inside the stream. Every failure becomes the turn's error text, written to say what happened, what to do, and what OpenRouter (and the model's provider) said. When the response has started, the message also gives the generation id to look up at [openrouter.ai/activity](https://openrouter.ai/activity). Guanaco never retries by itself; use **Retry request**.

| Situation | What Guanaco tells you |
| --- | --- |
| No key saved | Add a key in Configuration. Nothing is sent. |
| 401, unknown or disabled key | The key was rejected or belongs to no account; check or recreate it. |
| 402, not enough credits | Add credits, lower the Response limit (credit is reserved for it), or choose a `:free` model. |
| 403, key or workspace budget reached | Spending and limit, when the limit resets, and where to raise it. |
| 403, moderation or provider refusal | Which provider declined, why, and the flagged text. |
| 404, no endpoint for your privacy settings | Free models often need providers that may train on or publish prompts; review [privacy settings](https://openrouter.ai/settings/privacy) or choose another model. |
| 404, no provider serves the model | It may be retired or renamed; refresh the model list. |
| 400, conversation too long | Start a new conversation, shorten the message, lower the Response limit, or choose a larger context. |
| 400, unknown model id | Refresh the model list and choose again. |
| 400, other | Not every model supports every setting; check stop sequences, JSON format, and advanced values. |
| 429, free-model limit | 20 requests per minute and 50 per day (1,000 per day after buying at least 10 credits), with the reset time when OpenRouter gives it. |
| 429, upstream | The model's provider is limiting OpenRouter, not your account: retry soon, choose another model, or add your own provider key. |
| 408, 502, 503 | The model was too slow, its provider is down or overloaded, or no provider is available; retry or choose another model. |
| 500, 52x | OpenRouter or its network edge failed; retry and check [status.openrouter.ai](https://status.openrouter.ai). |
| Error event inside the stream | The same explanations. The partial answer stays visible but is not used as history. |
| Stream closed without finishing | Retry the turn. |
| Network failure | Check the connection and anything that may block `openrouter.ai`: firewall, proxy, VPN, DNS filter, or an ad-blocking extension. A drop during the answer is reported separately. |
| Timeout | Increase Request timeout, lower the Response limit, or choose a faster model. |

[OpenRouter errors reference](https://openrouter.ai/docs/api-reference/errors)

A `200` reply can contain no text: a model warming up, or a reasoning model that spent the whole Response limit on reasoning. The chat then says the model returned no answer text; raise the Response limit or retry a little later.

## Limitations

- OpenRouter does not expose `Retry-After` or `X-RateLimit-*` response headers to browser pages. Guanaco shows a reset time only when OpenRouter includes it in the error body.
- Cancelling stops generation and billing only on providers that support it; others finish and bill the full response.
- Text only. Images, files, tools, and web search are not sent, even to models that support them.
- Requests leave this computer. OpenRouter and the company hosting the model receive the system prompt, the message, and earlier completed turns. Check their data policies at [openrouter.ai/settings/privacy](https://openrouter.ai/settings/privacy).
