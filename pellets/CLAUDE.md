# Pellets — maintenance guide

This file applies to the whole `pellets/` directory and is the entry point for
an assistant arriving with no conversation context: Claude Code, Codex, or any
other coding assistant. `AGENTS.md` only points here. Read `README.md` first for
user-facing behaviour and how to start the application.

`prompts/init.md` keeps the original prompt that produced this application.
Treat it as history, not as a specification to re-execute. `LICENCE.txt` is an
MIT licence; do not add per-file licence headers or change its terms.

---

## 1. Hard constraints

These are not preferences. Breaking one of them breaks the product.

- **One npm dependency: `ws`.** Nothing else, in any layer, including dev and
  test dependencies. The test suite uses Node's built-in `node:test`. The
  certificate builder, the multipart parser and the front end all exist because
  of this rule — do not "simplify" them by adding a package.
- **The front end is plain HTML, CSS and ES modules**, served as-is from
  `public/`. No framework, no bundler, no transpiler, no CDN, no build step.
  What is on disk is what the browser runs.
- **One process.** HTTP, static files and WebSocket all run in the same Node
  process, started by `npm start`.
- **No persistence for chat state.** Sessions, users, rooms, messages and
  presence exist only in memory. No database, no JSON on disk, no cache files.
  The one exception is `uploads/`, which is raw file bytes and is meant to
  survive a restart.
- **Messages are append-only.** There is no edit and no delete, anywhere — not
  in the domain, not in the protocol, not in the UI.
- **Dark mode is the default**, before any stored preference is read.
- **Picking a username is the only step** a client must complete. No
  registration, no password, no rules about what a username may be.
- **Communicate with the user in Spanish. Write code, comments, documentation
  and interface text in English.** (Repository-wide convention.)
- **Comment for the next assistant.** Explain *why*, not *what*. Several
  non-obvious decisions in this codebase are documented in place; keep that up.

---

## 2. Architecture

Dependencies flow in one direction and never back up:

```
config ──▶ EventBus + stores ──▶ domain services ──▶ transports
                   ▲                    │
                   └──── events ────────┘──▶ broadcasters ──▶ WebSocket frames
```

### The event bus is the seam

`src/lib/events.js` is what makes the whole thing pluggable. A domain service
never talks to a socket: it publishes an event, and `src/realtime/broadcasters.js`
is the *only* module that turns an event into a WebSocket frame. That is why a
room created over REST is broadcast to every open socket without the REST route
knowing sockets exist.

Every published event name lives in the `EVENTS` constant. Never publish a raw
string literal — a typo in a literal is silent, a typo in an import crashes.

### Layers

| Layer | Directory | Knows about |
| --- | --- | --- |
| Helpers | `src/lib/` | Nothing. Pure functions and `node:*`. |
| Stores | `src/store/` | Plain data structures. No rules, no events. |
| Domain | `src/domain/` | Stores, the bus, config. **All business rules.** |
| HTTP | `src/http/` | Domain. Never touches a store directly. |
| Realtime | `src/realtime/` | Domain. The only place that imports `ws`. |
| Client | `public/js/` | The HTTP and WebSocket APIs. |

**Where to put a rule:** in `src/domain/`. Both transports call the same domain
function, so "only the creator may delete a room" is written once, in
`src/domain/rooms.js`, and both `DELETE /api/rooms/:id` and the `room:delete`
frame inherit it.

### The three Lego boards

Adding a feature means dropping a file in one of these directories and adding
one line to its `index.js`. Nothing else changes.

1. **HTTP routes** — `src/http/routes/`. A route module is
   `(router, deps) => void`. Register it in `ROUTE_PLUGINS`.
2. **WebSocket handlers** — `src/realtime/handlers/`. A handler module is
   `(registry, deps) => void`. Register it in `HANDLER_PLUGINS`, and add the
   frame types to `src/realtime/protocol.js` at the same time.
3. **Client views** — `public/js/views/`. A view is `(ctx) => ({ destroy })`.
   Register it in `ROUTES` in `public/js/views/index.js`.

Client components in `public/js/components/` are independent factories; add one
by creating a file and importing it where it is needed.

---

## 3. How the important features work

### Sessions and "Client Metadata"

`src/http/middleware/session.js` resolves a session on **every** request, which
is what makes "open the site and the server already knows you" true for the very
first byte of HTML.

Resolution order:

1. The `pellets.sid` cookie, when it points at a live session.
2. A **client-metadata fingerprint**: SHA-256 over `User-Agent`,
   `Accept-Language`, `Accept-Encoding`, the UA client hints and the peer
   address. This recovers the session of a client whose cookie was cleared.
3. A brand new session with a fresh `crypto.randomUUID()`.

The same resolution runs during the WebSocket upgrade (cookies travel with it),
and the gateway sets the cookie on the 101 response through the `ws` `headers`
event, so a socket and a page load always land on the same session.

Neither signal is a security boundary and nothing pretends otherwise: a session
grants a name, a colour, and the right to delete rooms you created.

**Known trade-off:** two genuinely identical cookie-less clients — same browser
build, same language, same address — fingerprint the same and share a session.
`PELLETS_FINGERPRINT=0` disables the fallback; the test helper sets it so
simulated clients stay distinct.

### Colours

A user colour is stored as a **hue** (0–359), never as a finished colour. The
theme supplies saturation and lightness (`--user-sat`, `--user-lit` in
`public/css/tokens.css`), so one hue stays readable on both a near-black and a
near-white background without maintaining two palettes.

`randomHue(taken)` prefers a hue nobody is using, so the first 18 users all get
distinct colours and reuse spreads evenly afterwards. The point of the colour is
telling people apart; keep that property.

### Identity in messages

A message stores an immutable **snapshot** of its author (`{ id, displayName,
colorHue }`). The client also keeps a **live user directory** in
`public/js/core/state.js`, keyed by session id, updated by `user:updated`
frames. `messageList.repaintUser()` then repaints every message a renamed user
ever sent — without the server rewriting stored history, which would violate the
append-only rule.

### Presence

Counts are of **distinct sessions**, not sockets: three tabs are one person.
`src/store/presence.store.js` tracks connection → session, session →
connections, and room → session → connections, and reports `sessionJoined` /
`sessionLeft` so an event is published only when the visible count changes.

### Uploads

1. `POST /api/uploads` streams the body straight to `uploads/.{uuid}.part` and
   renames it into place once complete, so a half-uploaded file is never served.
2. The response carries the metadata; the client puts the upload id in a
   `message:send` frame.
3. The server resolves the id and embeds a metadata snapshot in the message.

Bytes on disk survive a restart; the in-memory metadata index does not. That
asymmetry is deliberate — an old file is still servable by its stored name, but
it is listed nowhere because the chat that referenced it is gone.

Files are always stored under a fresh UUID: the client's filename is used only
for display and for choosing an extension. `resolveStoredPath()` flattens any
path and re-checks containment, and dotfiles are rejected so in-flight `.part`
files can never be downloaded. User content is served with
`Content-Security-Policy: ... sandbox`, which neutralises an uploaded SVG.

### TLS

`--https` mints a **new** certificate on every run, even when `cert/` already
holds one. That is required behaviour, not an optimisation opportunity.

Since `ws` is the only permitted dependency, `src/lib/asn1.js` implements the
DER subset X.509 needs and `src/lib/selfSignedCert.js` assembles and signs the
certificate with `node:crypto`. EC P-256 by default (generation is ~7 ms, and
this runs at every start); `PELLETS_TLS_KEY_TYPE=rsa` selects RSA-2048. If the
in-process path ever fails, it falls back to the host `openssl` binary; nothing
else depends on that binary existing.

The certificate covers `localhost`, the hostname and every non-internal address
of the machine, so a phone on the same network gets only the expected
self-signed warning and not a name mismatch on top of it.

### Port selection

`app.listen()` walks upwards past busy ports: 8080, then 8081, then 8082, until
a bind succeeds. Starting the server must never fail just because something else
is already listening, and that holds for an explicit `--port` too — running
`npm start` twice simply gives you two servers.

Details worth keeping:

- **Only `EADDRINUSE` retries.** A privileged port or an address that is not on
  this machine is a real configuration problem; incrementing the port would hide
  it behind dozens of pointless attempts and a misleading final error.
- **Port 0 is passed straight through.** It already means "any free port", and
  the test helper relies on that.
- `config.portAttempts` (`PELLETS_PORT_ATTEMPTS`, default 64) bounds the walk.
  Setting it to 1 disables the fallback and makes a busy port fatal again.
- `app.bind(port, host)` is the single-attempt primitive; `app.listen()` is the
  loop around it. A failed bind leaves the `http.Server` object reusable, which
  is what makes retrying on the same server legal.
- The chosen port is what `listen()` returns, so the startup banner always shows
  the real URL, and a `warn` line explains any deviation from what was asked.

---

## 4. WebSocket protocol

Every frame is JSON with the same envelope:

```
client → server   { "type": "...", "id": "r7", "payload": { ... } }
server → client   { "type": "...", "replyTo": "r7", "payload": { ... } }
```

`id` is optional and opaque to the server; it is echoed as `replyTo` so the
client can correlate an answer or an error with its request.

**Client → server** (`C2S` in `src/realtime/protocol.js`): `ping`,
`rooms:list`, `room:create`, `room:delete`, `room:join`, `room:leave`,
`message:send`, `typing:set`, `profile:update`.

**Server → client** (`S2C`): `pong`, `ack`, `session:state`, `rooms:state`,
`room:created`, `room:deleted`, `room:stats`, `room:joined`, `room:left`,
`message:new`, `typing:state`, `presence:state`, `user:updated`, `error`.

**Handler contract:** a handler either sends its own frames and returns
`undefined`, or returns a value which the gateway wraps in an `ack` addressed to
the request's `id`. A request-shaped frame therefore always gets exactly one
answer — an `ack`, a purpose-built reply, or an `error`. If you add a handler
that a client `request()`s, it **must** do one of those two things, or the
client's promise hangs until it times out.

---

## 5. Things that cost time to discover

Every item here was a real bug during development. The fix is in place; the note
is so nobody re-introduces it.

1. **`WebSocket.close()` only accepts 1000 or 3000–4999.** Passing `1001`
   ("going away") throws `InvalidAccessError` and leaves the socket open. See
   the `pagehide` handler in `public/js/core/socket.js`.
2. **A navigated-away page keeps its WebSocket open.** Browsers park the old
   document with its socket alive, so the server keeps counting a user who
   already left. The `pagehide` handler closes it explicitly, and the server has
   an application-level idle timeout (`realtime.idleTimeoutMs`) as a backstop —
   protocol-level ping/pong is answered by the browser's network stack even for
   a frozen page, so only silence at the application level proves nobody is home.
   The client therefore sends a `ping` every 20 seconds from a page timer.
3. **A CSS custom property is substituted where it is DECLARED.** Declaring
   `--user-color: hsl(var(--hue) ...)` on `:root` freezes `--hue` at the root
   value and every avatar comes out the same colour. It is declared on `*`
   instead, so each element resolves the `--hue` it inherited. See the comment
   in `public/css/tokens.css`.
4. **An author-level `display` beats the UA's `[hidden]` rule.** `.btn` with
   `display: inline-flex` made `hidden` do nothing. `base.css` has an explicit
   `[hidden] { display: none !important; }`.
5. **Rule order beats media queries at equal specificity.** The base
   `.room-side { display: none }` was written *after* the `@media (min-width:
   900px)` block that reveals it, so the member rail never appeared. The base
   rule now sits above the media query, with a comment.
6. **An unsized inline `<svg>` renders at 300×150.** `base.css` gives every SVG
   `width: 1em; height: 1em` as a floor; components override it.
7. **The SPA fallback must not swallow server namespaces.** `/api/…` and
   `/uploads/…` are excluded in `createStaticHandler`, otherwise an unknown
   endpoint returns the HTML shell with a 200 instead of a JSON 404.
8. **Do not `req.destroy()` to abort a refused upload.** It races with the
   response and truncates it. Send `Connection: close` instead and let Node end
   the socket after the response is flushed.
9. **`node --test tests/` does not work on Node 24** — a directory argument is
   treated as a module path. The `test` script is plain `node --test`, which uses
   the default discovery patterns.
10. **A regex for a `name` parameter also matches `filename`.** The
    `Content-Disposition` reader anchors every parameter with `(?:^|;)\s*`.
11. **`Collection.update()` mutates in place.** Records are living objects; an
    open socket or a queued broadcast must never observe a stale copy. Do not
    "improve" it into returning a new object.
12. **`fetch()` cannot be told to trust a specific certificate.** The test HTTP
    client is built on `node:http`/`node:https` for that reason.
13. **An `http.Server` stays usable after a failed bind.** `listen()` emitting
    `EADDRINUSE` does not poison the object, so the port walk retries on the same
    server instead of building a new one (which would lose the `upgrade`
    listener the WebSocket gateway attached).

---

## 6. Tests

```bash
npm test                              # everything, ~7 seconds
node --test tests/realtime.test.js    # one file
PELLETS_SKIP_BROWSER_TESTS=1 npm test # skip the browser pass
PELLETS_TEST_LOG=debug npm test       # server logs during tests
```

| File | Covers |
| --- | --- |
| `lib.test.js` | ids, colours, cookies, mime, the event bus, DER, config |
| `cert.test.js` | X.509 output, parsed by `X509Certificate` and a live TLS handshake |
| `multipart.test.js` | the parser at chunk sizes down to one byte |
| `store.test.js` | collections, indexes, presence arithmetic, history |
| `domain.test.js` | every specification rule, without a server |
| `startup.test.js` | the port walk, its bounds, and what must not be retried |
| `http.test.js` | session bootstrap, REST, static files, range requests |
| `uploads.test.js` | the three attachment kinds, limits, restart persistence |
| `realtime.test.js` | join/history/broadcast/typing/presence/authorisation |
| `https.test.js` | TLS mode, `wss://`, a fresh certificate per run |
| `browser.test.js` | headless Chromium, end to end, HTTP and HTTPS |

`tests/helpers/server.js` boots an isolated instance on an ephemeral port with
its own temporary `uploads/` and `cert/`, and gives each simulated client its own
cookie jar and User-Agent. `tests/helpers/chrome.js` drives Chromium over the
DevTools Protocol using `ws` — that is why the browser tests add no dependency.

**When you change behaviour, add a test that would have failed before.** The
suite is the executable form of the specification.

---

## 7. Conventions

- ES modules everywhere (`"type": "module"`), `.js` extensions in every import.
- 2-space indent, single quotes, semicolons, trailing commas in multi-line
  literals, ~110 column soft limit.
- JSDoc on every exported function, with the *why* where it is not obvious.
- **Never use `innerHTML` in the client.** `public/js/core/dom.js` sets strings
  with `textContent` and deliberately offers no raw-HTML escape hatch. Every
  username, message, room name and filename flows through it.
- Domain errors are `AppError` (`src/domain/errors.js`) carrying a machine
  `code` and an HTTP `status`; each transport translates. Never throw a bare
  `Error` from a domain service.
- Client state changes go through `public/js/core/state.js` channels. Views
  subscribe to channels; only `public/js/main.js` turns socket frames into state.
- Run `npm test` before declaring anything done.

## 8. Deliberate non-goals

Do not add these without being asked. Each one contradicts something above.

- Persistence of any chat state, or a "just in case" backup file.
- Message editing, deletion, reactions or threads.
- Authentication, passwords, accounts or roles beyond "created this room".
- A build step, a framework, a CSS preprocessor or an icon package.
- Server-side image or video processing (it would need a dependency).
