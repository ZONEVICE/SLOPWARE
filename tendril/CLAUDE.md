# Tendril — maintenance guide

This file applies to the whole `tendril/` directory and is the entry point for
an assistant arriving with no conversation context: Claude Code, Codex, or
any other. `AGENTS.md` only points here. Read `README.md` first for what
Tendril does and how to run it. `prompts/init.md` keeps the developer's
prompts (the original one and a later one) as history, not as a specification
to re-execute. Section 10 records what the developer decided and how they
test; check it before changing behaviour they chose. `LICENCE.txt` is MIT; do
not add per-file licence headers.

---

## 1. Hard constraints

These are not preferences. Breaking one breaks the product.

- **Talk to the user in Spanish. Write code, comments, documentation and
  interface text in English.** (Repository-wide convention.)
- **One self-contained executable.** The whole front end is embedded in the
  binary by `build.rs`; running Tendril needs no other file, no Node.js, no
  network. `build.sh` / `build.ps1` only build. Windows links the CRT
  statically (`.cargo/config.toml`), Linux release binaries are static musl.
- **Server in Rust, GUI in plain HTML/CSS/JS** (ES modules, no framework),
  bundled by esbuild at build time only. CodeMirror 6, Monaco Editor and
  rcgen are required by the prompt.
- **Lowest RAM possible on the host.** Single-threaded tokio runtime
  (`current_thread`), blocking work on a bounded blocking pool (16 threads,
  10 s keep-alive), HTTP/1.1 only, assets served straight from the binary's
  read-only data, gzip-only (no compression at run time). Measured on Linux:
  ~2.3–2.6 MB RSS idle, ~5.5 MB at the peak of a full session, 1 thread at rest.
  On Windows 10 (MSVC release): ~1.2 MB private bytes idle (~6–11 MB working
  set, which counts shared DLL pages and the OS trims over time), stable across
  repeated terminal sessions; at rest it runs about three threads, as Windows
  adds a couple of pool threads of its own to every process. Each open terminal
  adds three threads, and console lines are written by a thread that exists only
  while there is something to write (`console.rs`). Heavy parts of the GUI
  (Monaco, xterm.js, each CodeMirror language) load lazily.
- **Defaults: HTTPS, port 6060, `0.0.0.0`.** A new self-signed certificate
  (rcgen, ECDSA P-256) on every start, written to `~/.tendril/cert/`.
  `tendril http` serves plain HTTP. A busy port moves to the next free one
  (64 tries, only on "address in use"; Windows' "access denied" counts as in
  use); port 0 is passed through; the banner prints the real port.
- **Password:** `--password` > `settings.json` `password` > a random
  8-character alphanumeric password (look-alikes `0O o1lI` excluded) printed
  once. Compared as SHA-256 digests in constant time (`subtle`).
- **Blacklist:** 3 wrong passwords block that IP for everything (403) until
  the process restarts; there is deliberately no other way to unblock. The
  check and the increment share one lock, so parallel attempts cannot
  exceed 3. **Everyone behind the same public IP, NAT, reverse proxy or VPN
  exit shares one counter and is blocked together** (the server sees one
  address; `X-Forwarded-For` is never trusted because it can be forged).
- **Workspace confinement:** every path from the browser is relative to the
  workspace and goes through `services/files/jail.rs`. Nothing is ever written
  into a workspace except the user's files: no caches, locks or settings
  (temporary save/upload files live next to their target only for the
  duration of the write and are removed on any failure).
- **Persistence only in `~/.tendril/`** (`HOME` / `USERPROFILE`), JSON only:
  `settings.json`, `recent.json`, `logs/*.jsonl`, plus `cert/*.pem`.
- **Idle shutdown cannot be disabled** (minimum 1 minute; very large values
  are allowed). Only user actions count as activity (see section 5).
- **Nine themes**, theme saved in `localStorage` (`tendril.theme`), first
  visit follows `prefers-color-scheme`. All icons are hand-drawn SVG
  (`web/src/app/core/icons.js`).
- **`panic = "abort"` in release.** The panic hook (`src/main.rs`) writes the
  panic to the log synchronously first. Never `unwrap()` on input.
- **Never log passwords, session tokens or file contents.**

### Dependencies (and why each one)

| Crate | Why |
| --- | --- |
| `axum` (http1, json, query, tokio, ws) | Routing, extractors, the WebSocket upgrade for the terminal |
| `tokio` | Async runtime, run as `current_thread` |
| `hyper`, `hyper-util` | The connection-level HTTP/1.1 server, driven by our own accept loop |
| `tower` (util) | `oneshot` to drive the Router; already in axum's tree |
| `http-body` | The streaming file body (`http/body.rs`) |
| `rustls`, `tokio-rustls` (ring) | TLS. ring instead of aws-lc-rs: no CMake/NASM, cross-compiles with `zig cc` |
| `rcgen` (ring) | The self-signed certificate (required by the prompt) |
| `ring` | SHA-256 and the OS CSPRNG; already required by rustls and rcgen |
| `subtle` | Constant-time comparison of password digests and session secrets |
| `serde`, `serde_json` | API, settings.json, logs |
| `portable-pty` | PTYs: `openpty` on Unix, ConPTY on Windows |
| `libc` (Unix) | `getifaddrs`, `gethostname`; already in portable-pty's tree |
| `tungstenite` (dev) | WebSocket client for the terminal tests; already in axum's tree |

Deliberately hand-written: CLI parsing, MIME table, local IPs, civil dates,
atomic files, the asset table (no rust-embed: `build.rs` embeds pre-gzipped
files and computes ETags from the gzip trailer), Range parsing, the port walk.
Front-end npm packages are dev-dependencies of `web/` only (esbuild, the
CodeMirror packages, `@replit/codemirror-minimap`, `monaco-editor`,
`@xterm/xterm`, `@xterm/addon-fit`), pinned to exact versions. Added later,
each a lazy chunk: `marked` (Markdown → HTML for the preview: GFM tables,
task lists and strikethrough with no dependencies of its own, much smaller
than markdown-it) and `@codemirror/merge` (the side-by-side and unified git
diff views, official CodeMirror, reuses the editor's grammars and colors).
Git is **not** a dependency: Tendril runs the `git` program of the host and
works without it.

---

## 2. Architecture

### Backend (Rust) — dependencies flow one way

```
core ──▶ config ──▶ services ──▶ http ──▶ app / console ──▶ main
```

| Layer | Path | Holds |
| --- | --- | --- |
| core | `src/core/` | No app knowledge: `clock` (UTC dates, RFC 3339, HTTP dates), `random` (CSPRNG, password, hex), `atomic` (temp file + rename, removed on drop), `jsonfile`, `netinfo` (host name, local IPs, minus container bridges and, on Windows, VM adapters via `GetAdaptersAddresses`), `procinfo` (RSS), `lock` (poison-tolerant locks) |
| config | `src/config/` | `paths` (`DataDir`), `settings` (struct with serde defaults, unknown keys preserved in `extra`, validation, JSON merge patch), `cli` |
| services | `src/services/` | The rules, no HTTP: `events` (Event enum + Bus), `logger`, `auth`, `activity`, `shutdown`, `workspaces` (+ recent.json), `terminals`, `git` (the host's `git` program), `files/{jail, ops, text, search, picker, mime}` |
| http | `src/http/` | `listen` (port walk), `tls` (rcgen + rustls), `server` (accept loop), `state` (`AppState`), `guard` (middleware + extractors), `assets`, `error`, `body`, `routes/*` |
| app | `src/app.rs` | Composition root: start-up order, background tasks (watchdog, log flusher, signals), shutdown |
| console | `src/console.rs` | The banner and the console event reporter |

`src/lib.rs` exposes everything so `tests/` can start real instances in
process (`app::start` + `app::run_until_stopped`).

**Request pipeline** (`http/server.rs` → `http/guard.rs` → route):
accept (128-connection cap) → TLS handshake (10 s timeout, ALPN http/1.1) →
hyper http1 (30 s header timeout, upgrades on) → `PeerIp` extension →
`guard::guard`: blacklist (403) → `allowed_hosts` (421) → `Origin` check for
non-GET/HEAD/OPTIONS and WebSocket upgrades (403 `cross_origin`) → session
cookie → `SessionCtx` → route → security headers on the way out (CSP built
per request with the `ws(s)://<Host>` for the terminal). Private routes add
`guard::require_session` (401, and records activity unless the request has
`X-Tendril-Quiet` or is in `guard::PASSIVE`). Unmatched paths fall through
to `routes/pages.rs` (the embedded front end).

### Front end (`web/src/`)

```
public/            login page (login.js, login.css) and boot.js (theme before first paint)
styles/            themes.css (all palettes) + app.css (imports the rest)
app/main.js        builds `app`, shows the picker or the workbench
app/core/          api, bus, commands (+ keybindings), settings, themes, icons, languages, fuzzy, indent, paths, store, activity, dom (h()), format
app/ui/            menubar (+ menu model), menu, toolbar, statusbar, quickpick, dialog, toast, tooltip, splitter
app/workbench/     workbench (layout, sidebar, panel), documents (model + save/conflicts), groups (editor groups +
                   the app.tabs / app.editors facades), tabs (one group's strip), editorhost (one group's editor)
app/editors/       codemirror/{adapter, languages, theme}, monaco/{adapter, bundle}
app/sidebar/       explorer (the tree), search (find in files), scm (Source Control view)
app/viewers/       media (image, video, audio, PDF, binary card), diff (git diffs, @codemirror/merge)
app/preview/       markdown (Markdown → sanitized HTML for the preview)
app/terminal/      panel (xterm + WebSocket), bundle (xterm entry)
app/pages/         picker, settings, shortcuts, welcome
app/features/      everything the user can do, as commands/menus/toolbar entries
```

The `app` object every feature receives: `api, bus, commands, menus,
toolbar, statusbar, settings, workspace, documents, groups, tabs, editors,
explorer, sidebar, panel, terminals, git, activity, ui { toast, dialog }`. In the browser
console it is `window.__tendril` (the e2e test and the screenshot tool use it).

**Documents vs editors.** `workbench/documents.js` owns each open file's
state (text when no editor holds it, dirty, eol, bom, mtime, size, readonly,
language, indent, conflict). The editor area has one or two **editor
groups** (`workbench/groups.js`), each with its own tab strip
(`workbench/tabs.js`) and editor host (`workbench/editorhost.js`, one adapter
alive per group, both on the same engine); switching engines asks each
adapter for every document's text, destroys it, loads the other one.
`app.tabs` and `app.editors` are **facades** over the groups: "current file"
calls go to the active group, document calls (text, saved state, language,
close) to every group. A document open in both groups: CodeMirror views
replay each other's edits (`onLocalChanges` → `applyRemoteChanges`, outside
the undo history, annotated so programmatic `setText` is never replayed) and
share the saved snapshot; Monaco editors share one refcounted model. Adapter
interface: `open, close, getText, setText, markSaved, applyRemoteChanges,
setLanguage, setDocOptions, setOptions, setTheme, exec, supports, cursor,
focus, layout, destroy` (documented in editorhost.js).

**Bus events** (`app.bus`): `doc:opened`, `doc:closed`, `doc:dirty`,
`doc:saved`, `doc:reloaded`, `doc:renamed`, `doc:conflict`, `doc:language`,
`doc:indent`, `doc:eol`, `doc:edited` (any edit, for live previews),
`tab:active` (the active group's tab), `editor:switched`, `editor:cursor`,
`editor:focus`, `editor:blur`, `fs:changed`, `settings:changed`,
`theme:changed`, `command:ran`, `idle:status`, `server:stopped` (the idle
countdown ended and the server is gone), `panel:shown`, `panel:hidden`,
`panel:resized`, `sidebar:view`, `explorer:rendered`, `git:status`,
`git:busy`.

**Themes.** `styles/themes.css` is the single source of truth: one block of
CSS variables per theme on `html[data-theme]`, all colors hex (Monaco needs
hex). CodeMirror's theme and highlight style use the variables directly, so
a theme switch needs no reconfiguration; Monaco and xterm themes are rebuilt
from computed variables on `theme:changed`. Decorations beyond color live in
`styles/theme-extras.css` (Gorbino's chrome frame and red eyes, DOS
double-line frames and hotkey letters, CRT scanlines for Nuclear/Ambar…).

### Build and embedding

`node web/build.mjs` → esbuild bundles (minified, ESM, code splitting) into
`web/.out/` and gzips every file into `web/dist/`:

- `assets/public/*` — boot, login, themes (served without a session);
- `assets/app/main.js` + `assets/app/chunks/*` — the workbench, CodeMirror
  and one chunk per language (hashed names, cached as immutable);
- `assets/app/monaco/*` — Monaco built separately, loaded by URL with its
  CSS; its workers are classic scripts under `monaco/workers/`
  (`MonacoEnvironment.getWorker`), never from a CDN;
- `assets/app/xterm/*` — xterm.js, loaded by URL with its CSS.

`build.rs` turns every `web/dist/**.gz` into a sorted `ASSETS` table with
`include_bytes!` (ETag = CRC-32 + size from the gzip trailer) and refuses to
build if `web/dist` is missing or `version.txt` disagrees with Cargo.toml.
It also warns (`cargo:warning`) when `web/dist` is older than `web/src`,
`web/build.mjs` or the npm manifests, which it watches so the check runs again
after they change. `web/dist` is a build output: a synced or checked-out tree
can bring new sources without it.

---

## 3. Extension points — where to drop a file

- **HTTP endpoint:** a module in `src/http/routes/` with
  `pub fn register(routes: Routes) -> Routes` adding to `routes.private`
  (session required, counts as activity) or `routes.public`; add one line to
  `ROUTES` in `routes/mod.rs`.
- **Reaction to server events** (metrics, notifications…): one line in
  `app::wire_subscribers` with a closure over `&Event`. New facts are new
  variants of `services::events::Event` (serde tag = log `event` name).
- **Setting:** a field in `Settings`/`EditorSettings`/`UiSettings`
  (`src/config/settings.rs`, with its default and validation) and one row in
  `SECTIONS` of `web/src/app/pages/settings.js`.
- **Front-end feature:** a module in `web/src/app/features/` exporting
  `register(app)` that registers commands (`app.commands.register({ id,
  title, category, icon, keys, run, when, checked, native, terminal })`),
  menu entries (`app.menus.add(menuId, { command, group, order })`), toolbar
  buttons (`app.toolbar.add({ command, group, order, priority })`), status
  items or sidebar views; add one line to `FEATURES` in `features/index.js`.
- **Sidebar view:** `app.sidebar.addView({ id, title, icon, render, onShow, actions })`;
  `app.sidebar.setBadge(id, text)` puts a count on its tab.
- **Page in a tab** (like Settings): `app.tabs.openPage({ id, title, tip, icon,
  render, onShow, onClose })`; `app.groups.openPageBeside(page)` opens it in
  the other editor group (the Markdown preview). `onClose` also runs when a
  page moves to the other group (it is rendered again there).
- **Button on every tab strip:** `app.groups.addAction({ command, icon,
  title, when(tab) })` (Split Editor, Open Preview to the Side).
- **Explorer row decorations:** `app.explorer.setDecorator((path, isDir) =>
  ({ className, badge, title }) | null)` (git colors; one provider).
- **Language:** one entry in `LANGUAGES` (`core/languages.js`) and, for
  CodeMirror, one loader in `editors/codemirror/languages.js`.
- **Theme:** a block in `styles/themes.css` defining every variable of the
  Dark block, an entry in `THEMES` (`core/themes.js`) and in `public/boot.js`
  and `public/login.js`. Its `--editor-line` must be translucent (section 6).
- **Icon:** one entry in `ICONS` (`core/icons.js`).
- **Viewer:** extension lists in `core/languages.js` (`VIEWERS`) and
  `src/services/files/mime.rs`, a renderer in `viewers/media.js`.

---

## 4. Wire protocol and file formats

### HTTP API (JSON unless noted; errors are `{error, message, ...}`)

Public: `POST /api/auth/login {password}` → 200 `{ok}` + cookie | 401
`{error:"wrong_password", remaining}` | 403 `{error:"blocked"}`. Pages: `/`
(login or editor, `no-store`), `/assets/public/*`, `/favicon.svg`,
`/robots.txt`.

Private (session cookie; mutating requests need a same-origin `Origin`):

| Endpoint | Notes |
| --- | --- |
| `POST /api/auth/logout` | ends the session and its workspaces |
| `GET /api/picker/roots` | `{roots, home, recent, separator}` |
| `GET /api/picker/list?path=<absolute>` | folders only: `{path, parent, crumbs, dirs, truncated}` |
| `POST /api/workspace/open {path}` | `{id, root, name}`; the id goes in `X-Tendril-Workspace` (or `?ws=`) |
| `GET /api/workspace` | validates the id after a reload |
| `GET /api/fs/list?path=` | `{entries:[{name, kind, size, mtime, symlink?, unreachable?, readonly?, hidden?}], truncated}` |
| `GET /api/fs/stat?path=` / `POST /api/fs/stats {paths}` | metadata; `stats` is quiet polling for external changes |
| `GET /api/fs/read?path=` | text/plain, LF, no BOM; headers `X-Tendril-Mtime/-Size/-Eol/-Bom/-Readonly`; 413 `too_large`, 415 `binary` |
| `PUT /api/fs/write?path=` | body = LF text; `X-Tendril-Eol`, `X-Tendril-Bom`, optional `X-Tendril-Expect-Mtime` + `-Size` → 409 `conflict {mtime,size,exists}` |
| `POST /api/fs/create {path, dir}` / `rename {from,to,overwrite}` / `copy {from,to}` / `duplicate {path}` / `delete {paths}` | `delete` answers `{deleted, errors}` |
| `PUT /api/fs/upload?path=&overwrite=1` | raw body streamed to a temp file, renamed into place |
| `GET /api/fs/raw?ws=&path=[&download=1]` | streams with Range (206/416); HTML and unknown types as attachments with `CSP: sandbox`; SVG as image with `CSP: sandbox` |
| `GET /api/fs/files` / `POST /api/fs/grep {query, case_sensitive, whole_word, include}` | Go to File / Find in Files |
| `GET /api/term?ws=&cols=&rows=&path=` | WebSocket, see below |
| `GET /api/settings` / `PATCH /api/settings` (merge patch) | `password` never sent, only `password_set` |
| `GET /api/system/status` | `{idle_timeout_secs, idle_remaining_secs}`, never counts as activity |
| `POST /api/system/ping` | records activity (sent while the user types, ≤ 1/min) |
| `GET /api/system/info` / `POST /api/system/shutdown` | facts for Settings / stop the process |
| `GET /api/git/status` | `{available, repo, version, branch, commit, upstream, ahead, behind, files:[{path, orig?, staged?, unstaged?, conflict?, ignored?}], truncated}`; polled quietly |
| `GET /api/git/show?path=&ref=HEAD\|INDEX` | text/plain (LF); `X-Tendril-Exists: 0` and empty when not there |
| `POST /api/git/stage\|unstage\|discard {paths}` | `discard` restores tracked files from the index; untracked ones are deleted with `fs/delete` |
| `POST /api/git/commit {message, all}` | `{summary}`; empty message → 400 |
| `GET /api/git/branches` / `POST /api/git/checkout {branch, remote}` / `POST /api/git/branch {name}` | list, switch (remote: tracking branch), create |
| `POST /api/git/fetch\|pull\|push` | pull is `--ff-only`; push publishes a branch without upstream to `origin` |

Git errors: 409 `git_failed` (git's message), 400 `git_invalid`, 404
`not_a_repository`, 501 `git_unavailable`, 504 `git_timeout`.

### Terminal WebSocket

Client → server: **binary** = keystrokes (the only frames that count as
activity); **text** `{"t":"resize","cols":n,"rows":n}`. Server → client:
text `{"t":"hello","shell":"bash"}` first, then `{"t":"notice","text":…}`
when `terminal_shell` could not be started and the default shell runs
instead, **binary** PTY output, text `{"t":"exit","code":n}` when the shell
exits. Closing the socket kills the
shell (three threads per terminal: reader, control, waiter — see
`services/terminals.rs`).

### Files

- `settings.json`: pretty JSON, every key optional (`#[serde(default)]`),
  unknown keys preserved, written atomically with mode 600. An invalid file
  stops the start-up with line and column (it could hold the password).
- `recent.json`: `[{path, opened}]`, most recent first, 12 at most.
- `logs/YYYY-MM-DD.jsonl` (UTC days): one object per line starting
  `{"ts":"…Z","level":"info|warn|error","pid":N,"event":"…"}`. Events:
  `server.started|stopping|settings_warning`, `auth.login_ok|login_failed|ip_blocked|blocked_request|logout|password_changed`,
  `security.rejected`, `workspace.opened`, `fs` (`op`: write, create, mkdir,
  move, copy, delete, upload, download; `path`, `to`), `git` (`op`: stage,
  unstage, discard, commit, checkout, branch, fetch, pull, push; `paths`: a
  count — never messages or contents), `terminal.opened|closed`,
  `settings.changed` (key names only), `error`, `panic`, `log.capped`.
  Retention by age and total size; past the size cap only warnings and
  errors are kept for the day.

---

## 5. Behaviour that is easy to break

- **Activity.** Counted: non-quiet authenticated API requests, page loads,
  terminal keystrokes, `/api/system/ping`. Not counted: anything with
  `X-Tendril-Quiet` (status polls, `fs/stats`, tree refreshes on focus) and
  `guard::PASSIVE` paths whatever the headers say. The browser
  (`core/activity.js`) pings at most once a minute and only after real
  input. Keep new automatic requests `quiet: true`.
- **Workspace ids are per session** (`services/workspaces.rs`): a tab keeps
  its id in `sessionStorage` (`tendril.workspace`), so two tabs can edit two
  folders; another session cannot use the id.
- **Saving** sends the mtime/size seen at load; the server refuses with 409
  when the disk differs. `documents.checkDisk()` (window focus, every 30 s,
  quiet) reloads clean documents and flags dirty ones (`doc.conflict`).
- **Atomic writes keep permission bits and ownership** (`ops::keep_attributes`)
  — a saved shell script stays executable. Read-only files are refused, not
  forced. Symlinked files are written through to their target (inside the
  workspace); delete/rename act on the link itself.
- **Line endings:** the browser only sees LF; the server re-applies CRLF and
  the BOM on save. Mixed files are saved with the majority style.
- **Keyboard:** global shortcuts are handled in the capture phase before any
  editor; `native: true` commands are left to the focused editor; inside
  the terminal only `terminal: true` commands fire (palette, quick open,
  terminal toggle, settings). Browser-reserved keys (Ctrl+W/T/N) are not
  used: Alt+W closes a tab, Alt+N creates a file; Alt+PageUp/PageDown (and
  Alt+[ / Alt+]) cycle tabs. Shift+Alt+F is handled by Tendril (not native)
  so CodeMirror and Monaco without a formatter say why nothing happens.
- **Idle countdown.** The browser counts down every second from the last
  server answer (`core/activity.js`); the server's watchdog sleeps until the
  deadline (woken when the timeout changes), so both reach zero together.
  At zero the browser checks the server; two unanswered checks mean it
  stopped (`server:stopped` → the "stopped" page, with the unsaved files
  downloadable).
- **Editor groups.** At most two, side by side; phones/narrow windows merge
  them. A group whose last tab closes is removed. Tabs are remembered per
  workspace as `{groups:[{paths, active}], activeGroup}` (older `{paths,
  active}` still restores), and only after `groups.restore()` ran.
- **Git** (`services/git.rs`): never let git prompt (no stdin, no terminal —
  `setsid` on Unix, `CREATE_NO_WINDOW` on Windows —, `GIT_TERMINAL_PROMPT=0`,
  `GCM_INTERACTIVE=never`, `SSH_ASKPASS_REQUIRE=never`); pathspecs are
  literal (`GIT_LITERAL_PATHSPECS=1`) and validated by `jail::split`; status
  reads take no lock (`GIT_OPTIONAL_LOCKS=0`), writes are serialized; remote
  commands time out after 3 minutes (the process group is killed). Status is
  polled quietly every 15 s while the page is visible.

---

## 6. Bugs that cost time (do not reintroduce)

- **Terminal panel re-entrancy.** `terminals.create()` showed the panel,
  `panel:shown` called `create()` again → hundreds of terminals and a frozen
  page. Fixed with the `creating` flag and `if (!panel.visible)`.
- **Invisible text on selected tree rows** in themes whose selection is the
  solid accent (Gorbino, DOS, Nuclear, Ambar): the active file's name was
  colored with the accent. Rule is `.active-file:not(.selected)`. Likewise
  pressed toolbar buttons use `--pressed-fg`, and DOS's grey surfaces
  re-scope `--fg/--fg-muted` locally (`theme-extras.css`) because DOS is the
  only theme with light chrome text and light surfaces.
- **Inline rename lost text / committed early.** Repaints of the virtualized
  tree recreated the `<input>`. The same element is now moved between
  repaints (`editInput`) and blur commits only after a real loss of focus.
- **Toolbar overflow** at narrow widths: buttons have a `priority` (1 always,
  2 hidden ≤480 px, 3 hidden <768 px, 4 only ≥1280 px) and the menu bar
  collapses to one button below 1100 px.
- **A Chromium child with `stdio: 'pipe'` that nobody reads hangs** once the
  pipe buffer fills (it logs a lot). `tests/browser/cdp.mjs` uses `'ignore'`.
- **Orphaned Chromium after an interrupted test.** A test process killed by a
  timeout or Ctrl+C left headless Chromium running and its profile in the
  temp folder. `cdp.mjs` now kills every unclosed browser on `exit` (signals
  are turned into `process.exit`) and the e2e test kills its server there too.
- **`node --test <dir>` does not take a directory in Node 24**: use a glob
  (`node --test tests/browser/*.test.mjs`, `test/*.test.js`).
- **Monaco 0.57 layout:** import `monaco-editor/editor/editor.api.js`,
  `monaco-editor/features/register.all.js` and
  `monaco-editor/languages/register.all.js` (not the package root, which
  pulls an LSP client); workers are `esm/vs/editor/editor.worker.js` and
  `esm/vs/language/{json,css,html,typescript}/*.worker.js`.
- **Test data deleted too early:** `Server::wait_stopped` consumed the server,
  dropping its temp dirs before the test read the logs; it takes `&mut self`.
- **Tooling, not the app:** `pkill -f <pattern>` kills your own shell when the
  pattern appears in the command line that runs it. Track PIDs instead.
- **A second click on an open menu reopened it.** The menu closed on the
  window's `pointerdown` ("outside"), then the button's `click` saw it closed
  and opened it again. `openMenu` takes the `anchor` button, whose presses
  are not "outside"; `dropdown(button, items)` toggles. E2E: "a second click
  on an open menu closes it".
- **The last visit's tabs were wiped at start-up.** Creating the first group
  persisted its empty tab list before `restore()` read the saved one. Nothing
  is persisted until restore has run (`loaded`).
- **Split editor pitfalls:** `.workbench.sidebar-hidden .splitter-x` would
  also hide the group divider (it has its own class); a CodeMirror `setText`
  (reload from disk) replayed into the other view applied the change twice
  (`noReplay` annotation); a Monaco model disposed by one group broke the
  other (refcounted shared models); a page moved between groups kept its old
  bus subscriptions (`detachPage` calls `onClose`).
- **A stopped Tendril stayed alive while its console was paused** (found on
  Linux after a Ctrl+S, the same happens with a Windows QuickEdit
  selection): the console writer thread was blocked in `write`, holding the
  stderr lock, and `main`'s final `eprintln!("Tendril stopped…")` waited for
  that lock forever. The last line now goes through the same printer
  (`console::say`) and `console::drain` waits at most one second. Test:
  `draining_gives_up_on_a_paused_console`; checked end to end with a 4 KB
  pipe nobody reads (exits in ~1.2 s; the old binary never did).
- **Task-list boxes in the preview were nearly invisible:** browsers draw
  `disabled` checkboxes too faint. They are inert instead (`tabindex=-1`,
  `pointer-events: none`) with the theme's accent color.
- **An old front end was embedded without a word.** On the Windows machine
  `web/dist` was three weeks older than the `web/src` that had just arrived,
  and `build.ps1 -SkipWeb` embedded the previous interface: the e2e failed with
  `Cannot read properties of undefined (reading 'tabs')`. `build.rs` now warns
  when `web/dist` is older than its sources.
- **`a_paused_console_never_blocks_the_caller` was racy.** Which lines
  survived depended on whether the writer thread took the first line before
  the queue filled or after; on Windows it came late and a later line took the
  freed slot. The test now waits until the writer is blocked on the console,
  so exactly lines 0–256 come out, in order.
- **A one-line selection was invisible in Dos and Eye Burned** (GitHub issue
  #1, CodeMirror only). CodeMirror paints the selection in a layer behind the
  lines, and those two themes gave the active line an opaque color
  (`#0000c8`, `#ffffff`), which covered it; a selection over several lines
  still showed on the other lines. `--editor-line` is now translucent in every
  theme (Dos `#0000ff5a`, the same blue over its background; Eye Burned
  transparent) and `web/test/core.test.js` refuses an opaque one. Monaco was
  never affected.

### Windows (found and fixed on real Windows 10, build 19045)

- **The terminal's working directory kept the `\\?\` prefix** (S0). The jail
  returns a verbatim path (`\\?\C:\...`); passing it straight to the shell made
  `cmd.exe` refuse it ("UNC paths are not supported") and start in `C:\Windows`,
  and PowerShell show a `Microsoft.PowerShell.Core\FileSystem::\\?\...` prompt.
  `routes/terminal.rs` now hands the shell `jail::display(&root)` (keeping the
  verbatim form only past the classic MAX_PATH limit).
- **`terminal_shell` with spaces in the program path** (S3). `shell_command`
  split on whitespace, so `C:\Program Files\...\pwsh.exe` became two arguments.
  It now accepts a double-quoted program and takes the whole string when it
  names an existing file.
- **Console writes could freeze the whole server** (S2). `console::reporter`
  wrote with `eprintln!` on the single runtime thread, so a Windows QuickEdit
  selection (or Unix XOFF) in the console blocked every connection. Lines now
  go through `console::Printer`: a bounded queue (oldest 256 kept, the rest
  dropped) written in order by a thread that exists only while lines are
  pending, so Tendril still has one thread at rest. Write errors are ignored
  (`eprintln!` panics on a broken stderr, and release builds abort). The
  start-up banner stays synchronous. Tests:
  `a_paused_console_never_blocks_the_caller`,
  `the_writer_thread_ends_when_idle_and_comes_back`. (The Windows session
  first used a permanent writer thread; the Linux review made it on-demand.)
- **Draining the PTY after the browser left must stay Windows-only** (S1).
  On Windows the reader keeps reading to EOF so `ClosePseudoConsole` cannot
  block on a full pipe. On Unix it must stop at once: its descriptor of the
  master is what keeps the terminal alive, so a job that survives the shell's
  SIGHUP (disowned, or ignoring HUP) and keeps writing would otherwise keep
  the reader thread, and itself, running forever. Test (Unix):
  `closing_hangs_up_processes_that_outlive_the_shell`.
- **Fatal start-up errors vanished when double-clicked** (S4). Launched from
  Explorer, Tendril owns its console window, which closes on exit before the
  message can be read. `main.rs` now waits for Enter after an **error** when
  `GetConsoleProcessList` reports it is the only process on the console; never
  on a normal stop.
- **The e2e terminal step raced on Windows.** It waited for a sentinel that
  `echo` printed before `ls`, then looked for the listing, which PowerShell
  had not drawn yet. The sentinel is printed last now
  (`ls; echo e2e-$((20+22))`, valid in bash and PowerShell 5.1, which has no
  `&&`).
- **A jail test assumed Unix error variants.** `absolute_paths_stay_relative`
  expected `NotFound` for an outside absolute path; on Windows the drive-letter
  colon is refused earlier as `InvalidPath`. The assertion is now per-platform
  (the path is still refused, never escapes).
- **`build.ps1` failed with `error calling dlltool 'dlltool.exe': program not
  found`.** The developer's rustup defaults to the GNU toolchain, which needs
  MinGW's `dlltool` to build `windows-sys`, and the script ran a bare
  `cargo build`. It now selects an installed MSVC toolchain itself (section 7).

---

## 7. Windows

- Build on Windows with `build.ps1` (MSVC, static CRT). Cross-builds from
  Linux use `x86_64-pc-windows-gnu` through `cargo zigbuild` (`build.sh
  dist`); that `.exe` imports only system DLLs (kernel32, ntdll, ws2_32,
  advapi32, bcrypt, iphlpapi (adapter list), `bcryptprimitives` for `ProcessPrng`,
  `api-ms-win-core-synch-l1-2-0` and the UCRT `api-ms-win-crt-*` that ships
  with Windows 10), so it runs on Windows 10 and 11 as a single file.
- `build.ps1` picks the toolchain (`Select-Toolchain`): `RUSTUP_TOOLCHAIN` when
  set, else an installed `*-pc-windows-msvc` (warning when `vswhere` finds no
  C++ build tools), else GNU with rustup's bundled `dlltool` put on `PATH`
  (`ring` may still need a full MinGW-w64). The MSVC `.exe` is the reference
  Windows build: every Windows session tested it. The GNU cross-build is the
  same program and the developer has run it on Windows 10. Both are named
  `dist/tendril-<version>-windows-x86_64.exe`, but `dist/` and `web/dist` do
  not travel between the developer's machines: each machine builds its own.
- Binary sizes (1.0.0): gnu cross-build 6,840,320 B, Linux x86_64
  6,939,072 B, aarch64 6,637,128 B (`build.sh dist`); the MSVC release measured
  6,732,800 B on Windows 10 build 19045 (with the split editor, Markdown
  preview and git). `dumpbin /dependents` on the MSVC `.exe` lists only system
  DLLs (KERNEL32, ntdll, ws2_32, advapi32, bcrypt, bcryptprimitives,
  `IPHLPAPI.DLL`, `api-ms-win-core-synch-l1-2-0`) —
  the static CRT pulls in no `vcruntime`/`ucrtbase`. Memory: idle ~1.2 MB
  private / ~6–11 MB working set (Windows trims it over time); a full session
  with one terminal ~1.6 MB private and +3 threads; back to ~1.2 MB and the idle
  thread count after the terminal closes (no thread or process leak).
- Windows-specific code: drive letters (`picker.rs`, `GetLogicalDrives`),
  `\\?\` prefixes and case-insensitive containment (`jail.rs`), reserved
  names / ADS / trailing dots refused, `COMPUTERNAME`, `K32GetProcessMemoryInfo`
  (`procinfo.rs`), console-close handling (`app.rs`), the `GetConsoleProcessList`
  pause on a fatal start-up error (`main.rs`), the PowerShell / `cmd.exe` default
  shell and `terminal_shell` quoting (`terminals.rs`), the shell's working
  directory handed over without the `\\?\` prefix (`routes/terminal.rs`),
  read-only file deletion (`ops.rs`), draining the pseudoconsole to EOF after
  the browser left (`terminals.rs`), the adapter list without Hyper-V / WSL /
  VirtualBox / VMware adapters (`netinfo.rs`, VPNs kept; the default route's
  address is never filtered), git started with `CREATE_NO_WINDOW` (`git.rs`).
  The console event reporter writes from an on-demand thread so a paused
  console (QuickEdit) cannot block the runtime (`console.rs`, cross-platform).
- Clippy for the Windows target from Linux needs a C compiler for ring:
  `CC_x86_64_pc_windows_gnu=<zigbuild's zigcc wrapper> AR_x86_64_pc_windows_gnu=<its ar> cargo clippy --all-targets --target x86_64-pc-windows-gnu`
  (the wrappers live in `~/.cache/cargo-zigbuild/<version>/wrappers/`).

### What Wine can and cannot test (`tests/wine/run.sh`)

- **Wine 6.0 cannot run Tendril at all:** tokio's I/O layer (mio) opens
  `\Device\Afd`, which Wine 6.0 lacks ("Failed to open \Device\Afd\Mio").
  Use Wine 7+; on the development machine the Lutris runner
  `~/.local/share/lutris/runners/wine/wine-ge-8-26-x86_64/bin/wine` works
  (`WINE=… tests/wine/run.sh`).
- Rust's std needs `bcryptprimitives.dll!ProcessPrng`, missing from older
  Wine: `run.sh` builds a shim (`processprng.c`) with `zig cc`.
- **Verified under Wine 8:** start-up, banner, `C:\Users\<you>\.tendril`,
  drive letters in the picker, Windows paths as workspaces, CRLF
  preservation, refusal of `..\`, `name:stream` and `NUL`, file operations.
- **Not testable under Wine (8 or 9): the terminal.** portable-pty creates
  the ConPTY with `PSEUDOCONSOLE_INHERIT_CURSOR`; Wine's `conhost.exe`
  rejects the resulting `--inheritcursor` option and exits (code 1), taking
  the shell with it. Wine's `powershell.exe` is also a stub. Real Windows 10
  (1809+) supports both: **test the terminal on real Windows.**
- Memory under Wine (~19 MB working set) includes Wine itself; measure RSS
  on real Windows (Settings tab → About this server, or Task Manager).

---

## 7b. Verified on real Windows 10 (build 19045, 22H2)

Done on the developer's machine (Windows 10 Pro 19045, PowerShell 5.1, Rust
1.99 — note its default host was the `gnu` toolchain, so the MSVC builds were
run with `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc`, which `build.ps1`
now sets by itself — Node 24, Edge), in three rounds (2026-10-15, its
re-check, and 2026-11-07/08), each driven by a handoff prompt from the Linux
session. Those prompts and reports are not kept; section 7c keeps what a new
Windows session needs.

- **Build and suites pass (MSVC).** `.\build.ps1 -SkipWeb -Test`, `cargo test`
  (128 as of the 2026-11-07 re-check; 116 after the earlier Linux review added
  two `console` tests), `cargo clippy --all-targets -- -D warnings`,
  `cargo fmt --check`, `npm --prefix web test` (9) and the browser e2e
  (13 steps + the slow idle page, Edge), whose terminal step runs on Windows.
- **Terminal (ConPTY):** PowerShell and `cmd.exe` open in the workspace (after
  the S0 fix), resize, report the exit code, and die when the socket closes.
  ConPTY sends ESC[6n at start-up; xterm answers it in the browser and the
  ported tests answer it themselves.
- **ConPTY close (S1) did not hang.** Opening and closing 8 terminals with
  heavy output brought the thread count back to its idle baseline, with no
  orphaned shells or conhosts; on Windows the reader now drains to EOF once
  the browser is gone anyway, as insurance (see section 6 for why not on Unix).
- **Files and paths:** CRLF and the UTF-8 BOM are preserved; UTF-16 opens as
  "binary" (S6, a proposal); junctions outside the workspace are refused and
  junctions inside work; long paths (>260) create/edit/delete; a file locked by
  another process gives a clear error and leaves no temporary behind; deleting a
  folder with read-only files (a git repo) works; the picker lists every drive,
  handles `$Recycle.Bin` and refuses `System Volume Information` cleanly.
- **No `\\?\`** appears in the workspace root, listings, tabs or the prompt.
- **Visual review:** the nine themes at desktop (1366×768) and phone (390×844)
  render correctly with the Windows fonts (Segoe UI, Cascadia, Consolas) — no
  contrast, overflow or alignment problems.
- **Console output** (the Linux on-demand `Printer`): the operator lines
  (login, folder opened, terminal opened) appear in order; at rest there is no
  writer thread, so the idle thread count is about one lower than with the
  earlier permanent thread.

**Checked by the developer by hand** (two rounds, see section 10):

- First round: the Defender Firewall prompt and access from a phone; the S4
  "Press Enter" pause on a bad `settings.json`; closing the window with the X
  (logs `server.stopping`, "console window closed"); no freeze with a
  QuickEdit selection (S2); AltGr characters in both editors and the
  terminal; the Alt/Ctrl shortcuts (Alt+[ / Alt+] were unclear on a Spanish
  keyboard, hence Alt+PageUp/PageDown; Shift+Alt+F did nothing, now fixed);
  browser zoom; the whole UI on a real phone; the password blacklist; the idle
  shutdown; two instances (the second moves to 6061).
- Second round (2026-11-08), all OK: the menu toggle; the idle countdown and
  the "stopped" page; the split editor with both engines; the Markdown preview
  (live, links, local and remote images); git (Source Control, tree colors,
  branch switch and create, stage/unstage/discard, commit with Ctrl+Enter, the
  diff on desktop and phone); git on Windows with no credential window; the
  `terminal_shell` fallback; the S7 banner; Shift+Alt+F; Alt+PageUp/PageDown;
  Settings → Stop with a QuickEdit selection active (the window closes in
  1–2 s). The developer did not try pull/push/fetch (they use the terminal for
  that). Claude checked them on Linux on 2026-11-08 through the HTTP API
  against a local bare remote: publishing a branch with its upstream, fetch
  (behind 1), a fast-forward pull, a push to the upstream, and a diverged pull
  and push refused with git's message in 0.1 s. No automated test covers the
  successful remote path yet.

Still open on Windows: display scaling at 125 %/150 % (only browser zoom was
tried); a network share, empty card reader or `SUBST` drive in the picker (no
such hardware).

**Verified in the 2026-11-07 re-check (build 19045):** the virtual-adapter
filter of the banner (S7, `GetAdaptersAddresses`: the Hyper-V vEthernet
172.31.208.1 is gone, Wi-Fi and ZeroTier are kept); git through `git.exe`
(`CREATE_NO_WINDOW`, no console flash; Git Credential Manager never prompts — a
push to a bad GitHub origin fails in ~2.4 s with HTTP 409, no window appears);
the `terminal_shell` fallback (a bad shell falls back to the default, the tab
carries a one-line notice and the title is the real program name); and the
split editor, Markdown preview and idle "stopped" page in Edge. One caveat
surfaced: `web/dist` was stale on this machine (it does not arrive there with
the sources), so `-SkipWeb` shipped an old front end until it was rebuilt;
`build.rs` now warns about it (section 6). Three Linux-written test
assumptions were fixed there: a file named `*` in the git tests (invalid on
Windows: that case is Unix-only and Windows asserts the jail refuses `*`),
`core.autocrlf` (Git for Windows defaults it to true; the test repository pins
it off) and the console printer race (section 6).

---

## 7c. Working on Windows (for a new session there)

**The machine** (the developer's): Windows 10 Pro 19045 (22H2), PowerShell
5.1, Visual Studio 2026 Community with the C++ tools, rustup with both the MSVC
and the GNU toolchain (GNU is the default: `build.ps1` picks MSVC, and a bare
`cargo` needs `$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'`),
Node 24, Edge, Defender on, a Spanish keyboard (AltGr), and three network
adapters: Wi-Fi, a Hyper-V "Default Switch" vEthernet and ZeroTier, the VPN
the developer uses to reach Tendril from elsewhere.

**How the code gets there.** Syncthing syncs this repository, `.git`
included, between the Linux machine and Windows through a Raspberry Pi.
- Run git on one machine at a time, and on Windows only read-only commands
  unless the developer asks. `core.fileMode=false` is shared, so scripts are
  marked executable with `git update-index --chmod=+x`.
- Build outputs do not travel (`target/`, `node_modules/`, and in practice
  `dist/` and `web/dist`): run `npm --prefix web ci` and `.\build.ps1` there.
- Syncthing cannot replace a running `.exe`: run the binaries you test from a
  folder outside the synced tree.
- For `*.sync-conflict-*` files, follow `.claude/skills/syncthing-conflicts/`.

**Commands** (from `tendril\`): `npm --prefix web ci`; `.\build.ps1 -Test`
(the release `.exe` in `dist\`, then `cargo test`, expect 128, and the npm
tests); `cargo clippy --all-targets -- -D warnings`; `cargo fmt --check`; the
e2e with `$env:TENDRIL_CHROME` set to Edge's `msedge.exe`, then
`node --test tests/browser/*.test.mjs`; `dumpbin /dependents` from a Developer
PowerShell. If scripts are blocked:
`powershell -ExecutionPolicy Bypass -File .\build.ps1`.

**Tooling traps:**
- A Bash tool there may be Git Bash, whose `$!` is an MSYS PID. Start servers
  with PowerShell `Start-Process -PassThru`; stop them with
  `Stop-Process -Id <pid>` or `taskkill /PID <pid> /T /F`, never by name.
- `curl` in PowerShell 5.1 is `Invoke-WebRequest`: use `curl.exe`, pass JSON
  bodies from a file (`--data-binary "@body.json"`, because 5.1 breaks JSON
  quoting for native commands), send `Origin: <scheme>://<host>` with every
  POST including the login, and `-k` for the certificate.
- Tendril finds `~\.tendril` through `USERPROFILE`, never `HOME`.
- `%TEMP%` can contain 8.3 short names (`C:\Users\ABCDEF~1\...`) while
  canonical paths are long and `\\?\`-prefixed: compare canonical or
  `display()`ed forms in tests; never weaken the check.
- ConPTY needs Windows 10 1809+ and asks for the cursor position (`ESC[6n`)
  at start-up: headless test clients answer `ESC[1;1R` themselves.
- Hyper-V can reserve port ranges (`netsh int ipv4 show excludedportrange
  protocol=tcp`); binding inside one fails with access denied, which the port
  walk treats as "in use".
- Memory: `Get-Process -Id <pid>` (`WorkingSet64`, `PrivateMemorySize64`,
  `Threads.Count`). Private bytes are the stable figure: Windows trims the
  working set over time and adds about two pool threads to every process.

**A manual round on Windows**, beyond the suites:
- start-up by double-click (banner, `C:\Users\<you>\.tendril`, the
  certificate's SHA-256); Ctrl+C and the X both log `server.stopping`; two
  instances; a bad `settings.json` pauses with "Press Enter";
- a QuickEdit selection in the console freezes nothing, and Stop still closes
  the window;
- from a phone: the firewall prompt, Private and Public networks (the
  README's administrator commands), three wrong passwords block;
- the picker: every drive, `$Recycle.Bin`, `System Volume Information`, and a
  share, card reader or `SUBST` drive when available;
- files: the hidden attribute, CRLF / BOM / mixed endings, a locked file
  (`[IO.File]::Open($p, 'Open', 'ReadWrite', 'None')`), rapid auto-save with
  Defender on, read-only files, a folder holding a git repository, case-only
  renames, `CON` / `nul.txt` / `COM1` / a trailing dot or space / `a:b`
  refused, paths over 260 characters, junctions (`mklink /J`) inside and
  outside, uploads dragged from Explorer, the viewers, no `\\?\` anywhere;
- the terminal: PowerShell, `cmd.exe` and `pwsh` through `terminal_shell`,
  `echo ñandú € ─│┌`, Ctrl+C on `ping -t localhost`, resizing, `exit 3`,
  `max_terminals`, shells and their children gone on close and on stop;
- git through `git.exe`: no console flash and no credential window;
- the nine themes at desktop and phone size (`shoot.mjs`) with the Windows
  fonts; AltGr `@ # € [ ] { } \ | ~` in both editors and the terminal; the Alt
  shortcuts and Ctrl+` (Ctrl+º on a Spanish keyboard); display scaling.

Only the developer can answer the firewall prompt and run administrator
commands, use the phone, double-click and close the window, select text in the
console, type with AltGr, watch the desktop or plug in hardware. Ask for all of
it in one message with numbered steps.

**The S items** were suspicions from reading the code on Linux, checked on
Windows: S0 (the terminal's `\\?\` working directory), S2 (the console freeze),
S3 (shell paths with spaces) and S4 (vanishing start-up errors) were real and
are fixed (section 6). S1, a hanging ConPTY close, did not reproduce; the drain
stays as insurance. S5, ConPTY's `ESC[6n`, is handled. S6, UTF-16 files, stay
binary by decision; if that changes, the seam is `services/files/text.rs`
(`Decoded` gains an encoding, and `looks_binary` must not trip on UTF-16's NUL
bytes). S7, virtual adapters in the banner, is filtered (`netinfo.rs`).

---

## 8. Tests

```bash
# Linux: 136 (103 unit + 33 integration). Windows: 128 (96 unit + 32 integration).
cargo test
npm --prefix web test                        # 10 front-end unit tests (node --test)
cargo build && node --test tests/browser/*.test.mjs   # 13 e2e steps, headless Chromium/Edge
TENDRIL_E2E_SLOW=1 node --test tests/browser/*.test.mjs   # + the idle "stopped" page (over a minute)
```

The platform gap is the Unix-only tests (three `jail`, two `ops`, one
`atomic`, one `netinfo`, one `files_api`, one `terminals`) minus the
Windows-only `backslashes_and_drive_letters_on_windows`. The rest of
`terminals` and `tests/terminal.rs` run on both platforms (`/bin/sh` on Unix,
`cmd.exe` on Windows). The Windows figure of 128 was measured on
Windows 10 build 19045 (96 unit + 8 auth + 10 files + 2 git_api + 9 lifecycle +
3 terminal); it adds the git, shell-fallback, program-name, CSP, adapter-filter,
on-time-idle-stop and console-drain tests to the earlier 116. The git tests
need `git` installed; without it they pass empty.

| Where | Covers |
| --- | --- |
| unit tests in `src/` | dates, randomness, atomic files (no residue, mode 600), JSON files (errors without a repeated position), git (porcelain v2 parsing, literal paths, a real repository round, no repository), the CSP's remote images per scheme, Windows virtual adapters, settings (defaults, unknown keys, repair, patches, password never public), CLI, auth (lockout, parallel attempts, sessions, cap), activity, shutdown, jail (traversal, encoding, absolute paths, backslashes, symlinks, Windows names), text (BOM/CRLF/binary), ops (conflicts, permissions, read-only, copy/move/duplicate/delete, links), search, picker, terminals (shell selection, a real PTY shell on both platforms, hang-up of jobs that outlive the shell on Unix), the console printer (a paused console never blocks; on-demand writer thread), port walk, TLS minting, Range parsing, guard helpers, asset table |
| `tests/auth_and_security.rs` | login page vs editor, cookie flags, blacklist incl. parallel attempts and logs, cross-origin refusal before counting, security headers, `allowed_hosts`, 404s |
| `tests/files_api.rs` | traversal over HTTP (encoded, absolute, backslash, drive letters), symlink escapes, foreign workspace ids, CRLF+BOM round trip, conflicts, limits, binary, HTML/SVG sandboxing, Range, file operations, uploads, search, picker |
| `tests/lifecycle.rs` | HTTPS and a new certificate per start, port walk, settings round trip, password precedence, what counts as activity, idle shutdown (also on time with the production check interval), stop button, info |
| `tests/git_api.rs` | git over HTTP against the real `git`: not a repository, status, `show` at HEAD/index, stage/unstage/commit, branches, path confinement, push without remote, logs without messages |
| `tests/terminal.rs` | shell in the workspace (`/bin/sh` on Unix, `cmd.exe` on Windows; answers ConPTY's ESC[6n), output, resize, exit code, activity, kill on close, Origin/session/limit checks |
| `web/test/core.test.js` | paths (incl. link resolution), fuzzy matching, indentation detection, formatting, languages, shortcuts and key dispatch rules, the bus, the preview's URL filter and fence languages, translucent active lines in every theme |
| `tests/browser/workbench.test.mjs` | the whole UI against the real binary (see README): split editor with both engines, Markdown preview with hostile HTML, git staging/commit/diff, menus |

`tests/common/mod.rs` starts in-process servers (port 0, temp data dir,
fast watchdog) and a blocking HTTP/1.1 client (plain or rustls with an
accept-any verifier). **When you change behaviour, add a test that fails
without the fix.**

**Visual review is part of done.** After any UI change run
`node tests/browser/shoot.mjs --url … --password … --workspace … --out /tmp/shots`
(themes × desktop 1366×768 and phone 390×844; `montage` from ImageMagick
makes contact sheets) and look at the images: contrast, overflow, alignment.

---

## 9. Conventions and non-goals

- Rust 2024 edition, `cargo fmt` (120 columns, `rustfmt.toml`), `cargo
  clippy --all-targets` clean on Linux and Windows. Comments explain *why*;
  every module starts with a doc comment saying what it is for and how it
  connects. `unsafe` only for small FFI blocks, each with a `SAFETY` comment.
- Front end: no framework, `h()` from `core/dom.js` to build elements, text
  always via `textContent` (never `innerHTML` with data), every
  `localStorage` access through `core/store.js` (try/catch).
- Front end: the Markdown preview builds HTML only through `marked`, then a
  sanitizer on an inert `DOMParser` document, then `importNode` — never
  `innerHTML` on the live page.
- Non-goals (for now): regex Find in Files, more than two editor groups or
  top/bottom splits, Mermaid/math in the preview, git operations that rewrite
  history or delete branches (force push, reset, rebase, amend), git log /
  blame / graph and a merge-conflict editor, UTF-16 files (shown as binary,
  by decision), plug-in loading at run time, multi-user accounts, persistent
  sessions, HTTP/2, terminals that survive a page reload.

---

## 10. Decisions taken with the developer

**How the developer tests.** After each round the agent writes a checklist
in Spanish of what only the developer can check, plus questions and its own
liberties. The developer marks each item (`o` fine, `/` partial or pending,
`x` wrong), answers under `Respuesta:`, and says which proposals to build.
The checklist is a working file: it is not committed, and what matters from it
is recorded here and in section 7b. The developer also uses Tendril from a
phone (one round was answered through Tendril on a phone) and means to use it
to control their computers remotely, over ZeroTier.

Keep these unless the developer says otherwise:

- **Shortcuts:** the browser keeps Ctrl+W/T/N, so Alt+W closes a tab, Alt+N
  creates a file, and Alt+[ / Alt+] and Alt+PageUp/PageDown cycle tabs.
  Symbol shortcuts follow the US key position, as in VS Code, and the menus
  show US labels.
- **No preview tabs:** a click in the tree opens a normal tab.
- **The idle countdown** stays visible in the status bar. In the last five
  minutes it counts seconds; at zero the page says the server stopped and
  offers the unsaved files (the developer asked for this).
- **Defaults:** hidden files shown, auto-save off, confirm deletes, reopen the
  folder's tabs, wrap and minimap off, CodeMirror, idle shutdown after 180
  minutes, 4 terminals, a 5 MB editor limit, 1 GB uploads.
- **Per-device state stays in the browser** (theme, open tabs, panel sizes,
  sidebar, the picker's last folder), not in `~/.tendril`, although the
  original prompt put all persistence there; to be revisited only if it gets
  in the way.
- **A new certificate on every start**, so the browser warns every time, as
  the original prompt asked.
- **The interface is in English only**, for now.
- **The terminal** defaults to Windows PowerShell 5.1, logo included.
  `terminal_shell` is documented in the README; an unusable value falls back
  to the default with a notice.
- **QuickEdit stays enabled:** it lets the developer select the banner's
  password with the mouse, and a selection no longer freezes anything.
- **UTF-16 files stay closed** (shown as binary; S6).
- **The banner** leaves out virtual adapters, but VPN addresses (ZeroTier)
  must stay (S7).
- **Git** runs the host's `git`: nothing is bundled, and without git the
  feature hides. It covers viewing, stage/unstage/discard, commit, branches,
  fetch, pull `--ff-only` and push, and nothing destructive: no force push,
  reset, rebase, amend or branch deletion (the terminal is for that).
- **The split editor** works like VS Code's: at most two groups, side by side
  only, none on phones.
- **The Markdown preview** shows remote images (`https:`, plus `http:` when
  Tendril itself runs on HTTP); no Mermaid or math.
- **PDF and media** use the browser's own viewers (no pdf.js), so `.mkv` or
  `.avi` may not play.
