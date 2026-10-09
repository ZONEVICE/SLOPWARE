# AllySwally — maintenance guide

This file applies to the whole `allyswally/` directory and is the entry point
for an assistant arriving with no conversation context: Claude Code, Codex, or
any other coding assistant. `AGENTS.md` only points here. Read `README.md` first
for what AllySwally does and how to run it.

`prompts/init.md` keeps the original prompt that produced this application.
Treat it as history, not as a specification to re-execute. `LICENCE.txt` is an
MIT licence; do not add per-file licence headers or change its terms.

---

## 1. Hard constraints

These are not preferences. Breaking one breaks the product.

- **Talk to the user in Spanish. Write code, comments, documentation and
  interface text in English.** (Repository-wide convention.)
- **Rust standard library only, plus hand-declared Win32 FFI.** No third-party
  crates — not `windows-sys`, `tokio`, `serde`, `rand`, `tungstenite`, nor any
  framework or test harness. The Win32 ABI is spelled out by hand in
  [`src/win/ffi.rs`](src/win/ffi.rs) with `extern "system"`. Everything else is
  written from scratch: the HTTP/1.1 parser, the WebSocket (RFC 6455) handshake
  and framing, the JSON parser/serializer, SHA-1, Base64, and log writing. Do
  not "simplify" any of them with a dependency. `Cargo.toml` has **no**
  `[dependencies]` section, and it must stay that way.
- **The front end is plain HTML, CSS and ES modules**, embedded in the binary
  with `include_bytes!` ([`src/frontend.rs`](src/frontend.rs)). No framework,
  bundler, transpiler, CDN or web font. One `.exe` is the whole product.
- **A single self-contained `.exe`.** `.cargo/config.toml` links the CRT
  statically (`+crt-static`); the release profile is `opt-level="z"`, `lto`,
  `codegen-units=1`, `strip`. The binary must import only system DLLs — verify
  with the DLL-string scan in `README`/history if you touch linking.
- **`panic = "unwind"` (the default), never `"abort"`.** A panic in a client
  thread is caught per connection (`std::panic::catch_unwind` in
  [`src/server.rs`](src/server.rs)) and logged as a bug; the server never dies.
  `panic = "abort"` would make that impossible, so it is deliberately not set —
  there is a comment to that effect in `Cargo.toml`.
- **Port 8787 by default; a busy port is not an error.** Walk upward on
  `AddrInUse` only, 64 ports max, port 0 passed through, report the real port
  ([`src/http/listen.rs`](src/http/listen.rs)). Also guarded by a named
  single-instance mutex ([`src/win/instance.rs`](src/win/instance.rs)).
- **HTTP only, and nothing works without the PIN.** Only the static assets and
  `POST /api/pin` are served unauthenticated; every other `/api/*` route needs a
  valid `X-Token` header, and the WebSocket's first message must authenticate.
  The PIN is 6 chars from an ambiguity-free alphabet (no `O 0 I 1 L`), drawn
  from the OS CSPRNG (`BCryptGenRandom`). Three wrong tries lock that **IP** in
  memory until the process restarts — there is intentionally no in-app unlock.
- **Privacy in logs.** Never log the content of typed text or clipboard
  payloads (they may be passwords) — only a type and a count. Executed commands
  are logged in full as an audit trail. See `input.text` / `clipboard.send` /
  `script.run` events.
- **The data files are human-editable and hot-reloaded.** Writes are atomic
  (temp file + rename, [`src/paths.rs`](src/paths.rs)). A hand-edited file that
  becomes invalid JSON keeps its last valid value in memory, records the error
  with line/column, and is **never overwritten** ([`src/store.rs`](src/store.rs)).

---

## 2. Architecture

Dependencies flow one way and never back up. `main` wires it together; `state`
is the shared context handed to every connection thread behind an `Arc`.

```
win (FFI)  json  sha1  base64          ← primitives, no app knowledge
   │         │     │      │
   ├─────────┴─────┴──────┤
   ▼                      ▼
paths  log  config  auth  store  input  exec  firewall  events   ← services
   │                                                       │
   ▼                                                       ▼
http   ws                                            (pub/sub seam)
   │     │
   ▼     ▼
server ─────────────▶ api (http routes + ws commands) ─────▶ state
                                                               ▲
                        console_ui   frontend   main ──────────┘
```

| Layer | Path | Knows about |
| --- | --- | --- |
| Win32 FFI | `src/win/` | Only the OS. The one `unsafe` boundary; `ffi.rs` is raw, the rest are safe wrappers. |
| Primitives | `src/json`, `src/sha1.rs`, `src/base64.rs` | Nothing. Hand-rolled, each with tests. |
| Services | `src/paths.rs`, `log.rs`, `config.rs`, `auth.rs`, `store.rs`, `input/`, `exec.rs`, `firewall.rs`, `events.rs` | Primitives and `win`. State and rules, no transport. |
| Transport | `src/http/`, `src/ws/`, `src/server.rs` | Services. Parse requests, speak the wire; hold no rules. |
| API | `src/api/` | Services, through `state`. **All endpoint rules.** |
| Wiring | `src/state.rs`, `src/main.rs` | Everything. Builds services, binds, starts threads. |
| Console | `src/console_ui.rs` | The banner and PIN/address printing. |
| Front end | `src/web/` (embedded via `src/frontend.rs`) | The HTTP API and the WebSocket. |

The **pub/sub seam** is [`src/events.rs`](src/events.rs) (`Hub`). Domain code
announces events ("the MASKED files changed", "regenerate the PIN, kick
everyone") and never touches a socket; each live WebSocket registers a channel
and the hub fans messages out. This is why a file edited on disk refreshes the
shortcut band in every open browser without the file-watcher knowing sockets
exist.

### Concurrency

One thread per connection (1–3 clients expected), no async. Each connection is
wrapped in `catch_unwind`. A WebSocket connection runs a reader loop on its own
thread and a single writer thread fed by an `mpsc` channel — **all socket writes
go through that writer thread** (that is why server-side pongs are queued as
`Outgoing::Pong` rather than written from the reader). Background threads: a log
flusher (1 s), a file watcher + daily log prune (1.5 s), and an IP-change watcher
(5 s), all started in `main`.

---

## 3. Extension points — where to drop a file to add a feature

- **A new HTTP endpoint:** add one match arm in
  [`src/api/http.rs`](src/api/http.rs) (`fn api`). Authenticated by default;
  only static assets and `/api/pin` are public.
- **A new WebSocket command:** add one match arm in
  [`src/api/ws.rs`](src/api/ws.rs) (`handle_text`), or a new binary type byte in
  `handle_binary`.
- **A new MASKED category:** add it to `CATEGORIES` in
  [`src/state.rs`](src/state.rs), seed a default in `main`'s `seed_category`, and
  teach `run_item` in [`src/api/run.rs`](src/api/run.rs) how to execute it. The
  store, CRUD routes, band and export pick it up from the `CATEGORIES` list.
- **A new persisted file:** one `store.ensure(name, default)` call at startup;
  read/write it by name. Hot reload, atomic writes and error tracking are
  automatic.
- **A new front-end asset / module:** add one `embed!` line in `ASSETS`
  ([`src/frontend.rs`](src/frontend.rs)); the router serves it. A new tab module
  exposes `init(app)` and registers an `onShow` hook via `app.registerShow`.
- **A new Win32 capability:** declare it in `src/win/ffi.rs` and add a safe
  wrapper in the matching `src/win/*.rs` module. Nothing above `win` writes
  `unsafe`.
- **A new theme:** add a palette block in `src/web/styles.css` under
  `:root[data-theme="…"]` and an entry in `THEMES` in `src/web/themes.js`.

---

## 4. Wire protocol and file formats

### HTTP API (all JSON; `/api/*` except `/api/pin` need `X-Token`)

`POST /api/pin {pin}` → `{ok, token}` | 403 `{error:"wrong", remaining}` | 429.
`GET /api/bootstrap` → full snapshot (version, elevated, host, categories, band,
config, diagnostics). `GET /api/host`. `GET /api/masked?category=`,
`POST /api/masked/{save,delete,reorder}`, `POST /api/run {category,id}`.
`GET|POST /api/config`. `GET /api/diagnostics?level=&limit=`. `POST /api/latency`.
`POST /api/power {action}` (lock|monitorOff|suspend|reboot|shutdown).
`POST /api/server {action}` (regenPin|stop). `GET /api/export`,
`POST /api/import {mode,data}`, `POST /api/reset {target:"host"}`,
`POST /api/open-data-folder`, `POST /api/logout`.

### WebSocket (`ws://<host>/ws`)

First client message must be `{type:"auth", token}` → server replies
`{type:"authOk"}` or `{type:"authFail"}`. Then:

- **Binary frames** (the hot path): `[type:u8][i16 LE][i16 LE]`. Type 1 = move
  absolute, 2 = move relative, 3 = scroll (v, h). The client coalesces deltas
  once per `requestAnimationFrame` — never one frame per `pointermove`.
- **Text (JSON):** `ping`/`pong` (latency), `mouseMove`, `scroll`, `click`
  (+`double`), `down`/`up` (button), `key` (name+action), `media`, `combo`
  (keys[]), `text`, `run` (category+id).
- **Server → client:** `authOk`/`authFail`, `pong`, `bandReload` (+band),
  `configChanged`, `kick` (+reason), `runResult` (+result).

### Persisted JSON (`%USERPROFILE%\.allyswally\user-data\`)

`config.json` has `version`, `logRetentionDays`, `commandTimeoutSecs`,
`commandOutputLimitBytes`, `interpreters{python,node,ahkV1,ahkV2}`,
`firewallAutoRule`, `defaults{theme,showBand}`. Each MASKED item has `id`,
`name`, `description`, `showInBand`, `order`, optional `color`/`icon`,
`createdAt`, `updatedAt`, plus category fields: shortcuts `combo`/`keys`;
launchers `target`/`args`; clipboard `text`/`mode`/`restore`; scripts
`lang`/`source`/`code`/`path`/`args`/`runDetached`/`confirm`. The server owns
`id` and the timestamps; everything else is client/human-owned.

Logs are JSON Lines, one file per local day (`logs/YYYY-MM-DD.jsonl`).

---

## 5. Input injection (Win32 `SendInput`)

- **Keys use scancodes** (`KEYEVENTF_SCANCODE`), with the extended-key bit for
  the arrow cluster, the navigation block, right Ctrl/Alt and the Windows keys —
  many games ignore synthetic virtual keys. Names → VK in
  [`src/input/keymap.rs`](src/input/keymap.rs).
- **Text uses `KEYEVENTF_UNICODE`** (layout-independent; emoji via UTF-16
  surrogate pairs). The virtual keyboard sends plain characters as text, but a
  letter combined with Ctrl/Alt/Win is sent as a **combo** so shortcuts work.
- **Combos** press modifiers first and release in reverse. A client that drops
  mid-combo never leaves a key stuck: `InputSession::release_all` runs on
  disconnect (and on `Drop`), releasing every key/button that session held
  ([`src/input/mod.rs`](src/input/mod.rs)).
- **Absolute mouse mode** (default) reads `GetCursorPos`, adds the delta and
  jumps there — immune to the host's "Enhance pointer precision". Relative mode
  (`MOUSEEVENTF_MOVE`) is offered for games. The DPI multiplier and the optional
  acceleration curve are applied **client-side**, so the host's mouse settings
  are never touched. The process is per-monitor-DPI-v2 aware
  (`win::console::set_dpi_aware`) so absolute coordinates are correct under
  scaling and on multi-monitor.

---

## 6. Transport: Wi-Fi, hotspot, Bluetooth PAN, USB

The server listens on `0.0.0.0`; the front end builds `ws://${location.host}/ws`
and uses only relative paths, so it works over any IP link unchanged:

- **Bluetooth PAN.** On the Android phone, enable "Bluetooth tethering". On
  Windows, Bluetooth icon → *Join a Personal Area Network* → the phone →
  *Connect using → Access point*. The phone is usually `192.168.44.1`; the host
  gets an address on that subnet. Open `http://<host-ip>:8787`. The PAN
  interface appears **after** AllySwally starts; the console refreshes addresses
  every 5 s and logs the change.
- **Phone Wi-Fi hotspot.** Connect the host to the phone's hotspot, open the
  printed address.
- **USB tethering (RNDIS).** Enable USB tethering on the phone; the host gets an
  RNDIS address.

PAN and USB links are usually classified **Public**. When elevated, AllySwally
creates an inbound firewall rule valid on Private **and** Public profiles via
`netsh` ([`src/firewall.rs`](src/firewall.rs)); when not elevated it prints the
exact command to run. Sockets use `set_nodelay(true)`; movement is coalesced and
sent as compact binary; the client reconnects with exponential backoff and a
heartbeat (ping every 3 s, server reaps a connection after 35 s of silence).

---

## 7. Bugs that cost time (do not reintroduce)

- **`[hidden]` was overridden by display rules.** `.pin-screen { display: grid }`
  and `.app { display: flex }` beat the UA `[hidden] { display:none }` at equal
  specificity, so toggling `.hidden` did nothing and the PIN overlay stayed on
  top of the entered app. Fixed by a global `[hidden] { display:none !important }`
  at the top of `styles.css`. Keep it.
- **`SetSuspendState` has no mingw import library.** Linking `powrprof` fails on
  the gnu toolchain (`cannot find -lpowrprof`). It is resolved at **runtime** via
  `LoadLibraryW`/`GetProcAddress` in `win::power::suspend`. Do the same for any
  other powrprof/rarely-imported entry point.
- **`panic = "abort"` breaks per-connection isolation.** It was removed from the
  release profile for exactly this reason (see §1). A stray re-add would let one
  client's panic kill the server.
- **Landscape keyboard sizing.** A pure-CSS `transform: rotate(90deg)` with
  `calc()` sizing overlapped the toolbar. The rotated stage is now sized and
  centred in JS from the area below the command centre
  (`applyLandscape` in `src/web/keyboard.js`); it also re-runs on `resize`.
- **`INPUT` struct layout.** `size_of::<INPUT>()` must be 40 on x64 (4 type + 4
  pad + 32 union). The union is padded to the `MOUSEINPUT` size; a wrong field
  width silently corrupts `SendInput`. Validated by the app working, not by a
  test (SendInput needs a real session) — be careful editing `ffi.rs`.
- **Gboard reports `keyCode 229`.** The native-keyboard bridge relies on
  `input`/`beforeinput` diffing a hidden textarea with a sentinel zero-width
  space (to detect Backspace on an "empty" field), not on `keydown`.

---

## 8. Tests

```bash
cargo test
```

83 tests, ~9 s (the slow one is a real `ping` timeout in `exec`). Coverage:

- `src/sha1.rs` — RFC 3174 vectors incl. the 1,000,000-`a` case.
- `src/base64.rs` — RFC 4648 vectors and round-trips.
- `src/ws/handshake.rs` — the RFC 6455 key example
  (`dGhlIHNhbXBsZSBub25jZQ==` → `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`).
- `src/ws/frame.rs` — masked read, fragment reassembly, unmasked write, EOF.
- `src/json/` — parse/serialize, key order, line/column errors, surrogate pairs.
- `src/http/` — request parsing, percent-decoding, the port walk.
- `src/auth.rs` — PIN alphabet, lockout after 3, per-IP, session invalidation.
- `src/store.rs` — seed, save, invalid-edit tolerance, error clearing.
- `src/api/items.rs`, `src/api/bundle.rs` — the item model and import merge.
- `src/config.rs`, `src/events.rs`, `src/input/`, `src/exec.rs`, `src/log.rs` —
  CLI parsing, the hub, key mapping, command capture/timeout, civil dates.

The screenshot harness uses the debug-only `--dev-no-auth` flag (compiled out of
release via `cfg!(debug_assertions)`) plus `?tab=…&theme=…` URL params to reach
every screen behind the PIN. Verify the GUI at 360×800, 390×844, landscape,
768×1024 and 1280×800, in at least Dark, Light and Gorbino.

---

## 9. Conventions and non-goals

- Crate-wide `#![allow(dead_code)]`: the primitive modules expose a complete,
  tested API surface of which the app wires a subset. New members should still be
  used or tested, not left as speculative scaffolding.
- `windows-sys` is explicitly **not** used, by choice, to keep zero
  dependencies; the FFI is by hand. (The prompt permitted it; we declined.)
- No HTTPS, no accounts, no multi-user profiles — global config, in-memory
  sessions, HTTP only (so: no Clipboard API / Wake Lock / service workers; the
  front end feature-detects and never depends on them).
- Blocked IPs are cleared only by restarting the process — by design.
