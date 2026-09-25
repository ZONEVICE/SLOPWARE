# Reptile — maintenance guide

This file applies to the whole `reptile/` directory and is the entry point for
an assistant arriving with no conversation context: Claude Code, Codex, or any
other coding assistant. `AGENTS.md` only points here. Read `README.md` first
for user-facing behaviour and how to start the application.

`prompts/init.md` keeps the original prompt that produced this application.
Treat it as history, not as a specification to re-execute. `LICENCE.txt` is an
MIT licence; do not add per-file licence headers or change its terms.

---

## 1. Hard constraints

These are not preferences. Breaking one of them breaks the product.

- **Communicate with the user in Spanish. Write code, comments, documentation
  and interface text in English.** (Repository-wide convention.)
- **One npm dependency: `chokidar`.** Nothing else, in any layer, including
  dev and test dependencies. The test suite uses `node:test`; the browser tests
  drive Chromium over `--remote-debugging-pipe` precisely so they need no
  WebSocket package. The certificate comes from the system `openssl`; the HTTP
  client, router, NDJSON stream, SSE hub and front end are all hand-written for
  the same reason. Do not "simplify" any of them by adding a package.
- **The front end is plain HTML, CSS and ES modules** served as-is from
  `public/`. No framework, bundler, transpiler, CDN or build step.
- **Nothing about Reptile is persisted.** Hosted directory, PIN, sessions,
  sync bases, discovered instances: memory only, gone when the process exits.
  The only things written to disk are the synchronised files, Reptile's own
  short-lived `.reptile-<hex>.tmp` transfer files, and `cert/` for `--https`.
- **`npm start -- --https` mints a NEW certificate on every start** and
  replaces the one in `cert/`. Required behaviour, not an optimisation target.
- **A busy port is not an error.** Walk upwards from 55667 (or `--port`) on
  `EADDRINUSE` only; see `src/lib/listen.js`.
- **Unchecked items never leave the host and are never modified by the
  peer.** Every outgoing path (manifest, file download, live feed) and every
  incoming operation goes through `Selection.isExcluded`. See section 3.3.
- **An instance is in one mode at a time** (idle, hosting, syncing). Every
  transition goes through `src/domain/modes.js`.
- **One peer per hosted directory**, and HTTP only talks to HTTP, HTTPS to
  HTTPS.
- **Never mistake a vanished root for deletions.** If the watched directory
  disappears, stop; never propagate "everything was deleted".

---

## 2. Architecture

Dependencies flow one way and never back up:

```
config ─▶ lib ─▶ fs ─▶ domain ─▶ peer (outgoing HTTP) ─┐
                         │                             ├─▶ app.js wires them
                         └─ events ─▶ http (routes, SSE)┘    together
                                   └▶ reporters
```

| Layer | Directory | Knows about |
| --- | --- | --- |
| Helpers | `src/lib/` | Nothing but `node:*`. Network math, listen, cert, HTTP client, queues, wire paths, NDJSON, event bus. |
| Filesystem | `src/fs/` | `lib`. Entry states, walking, path validation, safe mutations, the index, the watcher. No network, no rules. |
| Domain | `src/domain/` | `lib`, `fs`. **All business rules**: hosting, syncing, discovery, selection, planner, PIN, modes, protocol names. |
| Peer | `src/peer/` | `lib`, `domain/protocol.js`. The syncing side's HTTP client and the discovery probe. |
| HTTP | `src/http/` | `domain`. Router, guard, SSE, static files, route plugins. Never touches the disk itself. |
| Reporters | `src/reporters/` | The event bus only. |
| Client | `public/js/` | The HTTP API and the SSE stream. |

The domain never imports a transport. `app.js` injects the two it needs:
`peerFactory` (creates `src/peer/client.js` clients) and `probe`
(`src/peer/probe.js`). That is what makes the services testable and keeps a
second transport possible.

**Where to put a rule:** in `src/domain/`. The HTTP routes only translate
requests into service calls; the peer routes in particular contain no rule
beyond parsing headers.

### The event bus is the seam

`src/lib/events.js`. Services publish (`STATE_CHANGED`, `HOSTING_*`,
`SYNC_STATE`, `MODE_CHANGED`, `ACTIVITY`, `DISCOVERY_UPDATED`); the SSE hub
and the reporters subscribe. Every event name lives in `EVENTS`; never publish
a string literal.

### The Lego boards (extension points)

Adding a feature means dropping one file in one of these directories and adding
one line to its index. Nothing else changes.

1. **HTTP routes** — `src/http/routes/`. A plugin is `(router, deps) => void`;
   register it in `ROUTE_PLUGINS` (`index.js`). Each route declares
   `{ access: 'ui' | 'peer' | 'public' }` (default `'ui'`, guarded).
2. **Event subscribers** — `src/reporters/`. A reporter is
   `({ bus, logger, identity }) => detach`; register it in `REPORTER_PLUGINS`.
3. **Client views** — `public/js/views/`. A view is
   `(ctx) => ({ el, destroy? })`; register it in `ROUTES` (`index.js`).

Client components in `public/js/components/` are independent factories
returning `{ el, update(...) }`; import them where needed.

---

## 3. How the important parts work

### 3.1 Identity, status bar, ping

`src/domain/identity.js`: a UUIDv4 per process (never stored), host name,
protocol, the real port (set after the port walk), live LAN addresses
(`src/lib/net.js` skips Docker/VPN/VM interfaces), and a machine fingerprint
(host name + MACs) used only to refuse syncing a directory into itself on the
same computer.

`GET /api/ping` (public) answers `{ app: 'reptile', version, protocolVersion,
uuid, hostname, protocol, port, mode, hosting: { id, name, connected } | null }`.
It never includes a path or the PIN.

### 3.2 Discovery

`src/domain/discovery.js`, probe in `src/peer/probe.js`. Two loops while
enabled:

- **Sweep** (every 8 s): targets are the /24 of each LAN interface plus
  loopback (`defaultScanHosts`), ports 55667–55686 (plus the instance's own
  port range when started elsewhere). Phase 1 probes the first port on every
  host; phase 2 probes the other ports only on hosts that answered (a refused
  connection counts as an answer), own addresses, loopback and hosts seen in
  the last five minutes. A /24 takes about two seconds.
- **Refresh** (every 3 s): re-ping known instances; drop those silent for 12 s.

A probe is a TCP connect (700 ms), then `GET /api/ping` over this instance's
protocol and, if the error smells of a protocol mismatch, the other one. That
is how HTTPS instances are found by HTTP ones and listed as incompatible.
Records are keyed by UUID (never listing our own); an instance seen on both
loopback and the LAN keeps its LAN address.

The status bar switch is `POST /api/discovery { enabled }`; turning it off
aborts both loops (every in-flight request uses the loop's `AbortSignal`).

### 3.3 Hosting and the selection

`src/domain/hosting.js`. Starting validates the path, the PIN, and the
selection, starts a watcher, walks the tree into the index (under the mutex),
and only then becomes visible.

**Selection model** (`src/domain/selection.js`): a set of EXCLUDED wire paths.
A path is shared unless it or an ancestor is excluded. New files are shared
unless they land inside an unchecked directory. Unchecked items stay unchecked
when the HOST renames them:

- exclusions below a renamed path are re-keyed (`applyRename`);
- each explicit exclusion's identity (`dev:ino`) is recorded, and an item that
  shows up elsewhere with that identity is excluded again (`followIdentity`),
  both synchronously on chokidar's raw add events and in each batch;
- things moved OUT of an unchecked directory follow their new location (they
  were not individually unchecked).

The watcher ignores the INSIDE of excluded directories (not the excluded
entries themselves, whose renames must be seen). Every peer operation goes
through `sharedPath()`, which answers `403 not_shared`. A peer deleting or
renaming a shared directory that contains unchecked items gets a partial
result: `removeTree` / `moveTreeSelective` in `src/fs/mutate.js` leave the
unchecked content (and its directories) in place, and the peer reconciles.

**Locking.** One mutex per share serialises the watcher's batches and every
commit made for the peer. A received file is written to a temp file outside the
lock, then, under the lock, the index is updated FIRST and the file renamed into
place. The watcher events that follow find the index already matching and
report nothing: that is the whole echo-suppression mechanism.

**Sessions.** `connect` checks, in this order: hosting at all (`409
not_hosting`), protocol (`400 protocol_mismatch`), another peer already
connected (`409 busy`, whatever the PIN), the PIN (`403 pin_invalid`), and the
same-directory case (`400 same_directory`). The same peer UUID reconnecting
replaces its old session. A heartbeat timer drops a peer silent for 20 s.
`setPin` ends the session with `bye pin_changed`; `stop` with
`bye host_stopped`.

### 3.4 Syncing: the engine

`src/domain/syncing.js`, class `SyncEngine`. States:
`connecting → syncing → live`, `reconnecting`, `pin_required`, and the terminal
`stopped` (host gone) and `error` (local directory gone).

- **One serial queue** runs everything that touches the local disk: remote
  operations from the stream, local watcher batches, reconciliations. They
  never interleave.
- **Generations.** Every (re)connection increments `generation`; queued work
  and timers from an older generation do nothing. Reconciliation timers and the
  `reconciling` guard are scoped to the current generation (section 5).
- **The index is the BASE**: the state last known to be identical on both
  sides. It changes only after the host confirmed an operation or a download
  was committed, never optimistically. A failed push is therefore retried by
  the next reconciliation instead of being mistaken for a remote change.
- **Reconciliation** (`reconcile`): fetch the manifest, walk the local tree,
  hash same-size files whose mtime differs and whose difference the base cannot
  explain, run the planner, execute deletions (deepest first), then
  directories (shallowest first), then transfers (8 in parallel). It runs on
  every hello, after conflicts or refused operations (bounded retries), and is
  what makes the engine self-healing.
- **The local watcher starts after the first reconciliation**, followed by a
  full `rescan()` that catches anything changed in the meantime. chokidar
  roughly triples the cost of writing a file into a watched tree, so a first
  sync of 5 000 small files took twice as long with the watcher already
  running.
- **Live, host → peer**: `ops` messages on the stream. `applyRemoteOne`
  applies an operation only when the local path is still in the base state;
  otherwise it schedules a reconciliation and lets the planner decide.
- **Live, peer → host**: watcher batches go out through `pushLocal`: writes
  as `PUT /api/peer/file` (one by one, with `Expect: 100-continue`), everything
  else batched in `POST /api/peer/ops`, preserving order. Each confirmed
  operation is committed to the base with `commitOp`.
- **Reconnection**: exponential backoff (1 s → 10 s); ping first (a different
  UUID means the host restarted: stop), then reopen the stream with the old
  token, or with the remembered PIN if the host forgot the session. A refused
  PIN switches to `pin_required`.

### 3.5 The planner

`src/domain/planner.js`, pure. Per path, with L (local), R (remote), B (base):
equal → nothing; only one side changed since B → that side wins; both changed
or no base → a modification beats a deletion, the newer mtime wins (tie: host),
file-vs-directory is a conflict left alone (and everything below it frozen).
Afterwards, directories are made consistent (a directory about to be deleted
on one side is kept, and recreated on the other, when something inside must
survive). Without a base (first connection) nothing is ever deleted: it is a
merge.

### 3.6 Change detection

`src/fs/watcher.js`. chokidar events (and raw fs.watch notifications, see
section 5) are only hints about which paths to look at. Each batch lstat's
those paths and diffs them against the index, in three phases:

- **A. renames**: a path whose inode belongs to an indexed path that is gone
  is a rename (directories first, so their children then compare equal);
- **B. additions, modifications, replacements** (a file replaced by a
  directory yields the removal and the creation, in that order);
- **C. removals**, held for `renameWindowMs` (the other half of a rename may
  arrive late, because chokidar holds `add` until a write settles), and
  collapsed so a deleted tree is one `rmdir`.

Batches are debounced (`quietMs` after the last event, at most `maxWaitMs`
after the first). Operations carry the new local `state` (with inode) so the
owner can commit them. `reindex` operations (same content, new inode) are
local bookkeeping and never sent.

### 3.7 The PIN

`src/domain/pin.js`: exactly four digits, generated with `crypto.randomInt`,
compared in constant time. No attempt limit, by specification. A "random" PIN
change always yields a different PIN; setting the same PIN again is a no-op
(no disconnection).

### 3.8 Certificates and TLS

`src/lib/cert.js` runs `openssl req -x509` with a throw-away config file (the
system `openssl.cnf` varies between distributions), EC P-256 by default with an
RSA fallback, `CA:FALSE`, `serverAuth`, SANs for localhost, the host name,
`<host>.local`, loopback and every LAN address. Files are written under
temporary names and renamed into place. Each process keeps the certificate it
generated in memory, so two HTTPS instances started from the same directory
both keep working even though `cert/` only holds the newest one. Peers connect with
`rejectUnauthorized: false` and pin the fingerprint seen at `connect`; a
different certificate later in the session fails with `certificate_changed`.

### 3.9 The control panel's guard

`src/http/guard.js`. The panel shows the PIN, so by default it answers only
requests from this machine's own addresses (`--remote-ui` lifts that). It also
refuses a foreign `Host` header (DNS rebinding), a foreign `Origin` or
`Sec-Fetch-Site: cross-site`, and non-JSON bodies (CSRF). Peer routes and
`/api/ping` are not subject to it.

### 3.10 The client

`public/js/main.js` creates one store fed by server-sent events
(`GET /api/events` sends the complete snapshot on every change, throttled to
~8/s), mounts the status bar, and starts the hash router (`#/`, `#/host`,
`#/sync?uuid=`). The status bar also carries a connection chip while hosting or
syncing, because the specification wants the connection state visible at all
times, not only on the start screen. `public/js/core/dom.js` builds every element with
`textContent`; there is deliberately no way to insert raw HTML, because host
names and file names come from other machines.

---

## 4. Wire protocol

All paths on the wire are **wire paths**: relative to the synced root, `/`
separated, no `.`/`..`/empty segments (`src/lib/wirePath.js`). Every incoming
path is normalised and re-checked for containment, and `src/fs/mutate.js`
refuses to write through a symlink.

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/ping` | none | identity + hosting |
| `POST /api/peer/connect` | PIN | `{ pin, protocol, peer: { uuid, hostname, machine, localPath } }` → `{ token, share, host }` |
| `GET /api/peer/stream` | token | NDJSON: `hello`, `ops`, `heartbeat`, `bye` |
| `GET /api/peer/manifest` | token | `{ share, entries: [{ path, kind, size, mtimeMs }] }` (shared only) |
| `POST /api/peer/hashes` | token | `{ paths }` → `{ hashes: { path: sha256 } }` |
| `GET /api/peer/file?path=` | token | raw bytes; `x-reptile-size`, `x-reptile-mtime` |
| `PUT /api/peer/file?path=` | token | raw body; `x-reptile-size`, `x-reptile-mtime`, optional `x-reptile-base-size`/`-base-mtime` |
| `POST /api/peer/ops` | token | `{ ops: [...] }` → `{ results: [{ ok, partial?, code?, message? }] }` |
| `POST /api/peer/heartbeat` | token | `{ phase, progress }` |
| `POST /api/peer/disconnect` | token | leave |

Operations: `{ op: 'mkdir', path }`, `{ op: 'write', path, size, mtimeMs }`
(stream only; uploads use `PUT`), `{ op: 'unlink', path, base? }`,
`{ op: 'rmdir', path }`, `{ op: 'rename', from, to, kind, base? }`. `base` is
the sender's last synced state; the receiver refuses (`409 conflict`) when its
own copy differs, and the sender reconciles.

`bye` reasons (`src/domain/protocol.js`): `pin_changed`, `host_stopped`,
`replaced`, `timeout`. Error bodies are always
`{ error: { code, message } }`; codes the peer acts on: `pin_invalid`,
`busy`, `not_hosting`, `protocol_mismatch`, `same_directory`, `not_shared`,
`conflict`, `unauthorized`.

Uploads use `Expect: 100-continue`: the host decides from the headers alone
(`prepareUpload`), so a refused or already-present file costs one round trip,
not the whole file. The route opts out of the automatic `100 Continue` with
`{ manualContinue: true }`; every other route gets it from `app.js`.

---

## 5. Things that cost time to discover

Every item was a real bug or trap during development. The fix is in place; the
note is so nobody reintroduces it.

1. **chokidar can lose a file for good.** When two reads of the same directory
   overlap, a stale read can "remove" a file that a newer read just added,
   which cancels its pending `add` (with `awaitWriteFinish`) and untracks it:
   no `add`, and later no `unlink` either. It showed up as "a file deleted on
   the peer is never deleted on the host" after two files were downloaded in
   parallel. The watcher therefore also listens to chokidar's `raw` fs.watch
   events, walks every new or renamed directory itself, and rescans the whole
   tree every five minutes. Do not go back to trusting high-level events alone.
2. **Raw hints bypass `awaitWriteFinish`**, so the batch defers any file whose
   mtime is younger than `stabilityMs` (future mtimes are not deferred, and a
   path is deferred at most 50 times).
3. **chokidar's `atomic` option silently ignores `*.swp`, `*~` and similar**
   and rewrites unlink+add into change. It is off; the batch logic handles
   atomic saves.
4. **A request whose `AbortSignal` is already aborted** used to be destroyed
   before its `'error'` listener existed, which crashed the process with an
   uncaught exception (seen only under load, when discovery was switched off
   mid-sweep). `httpRequest` now refuses to create such a request, and every
   response gets a no-op `'error'` listener.
5. **A reconciliation timer from an older connection blocked the new one**:
   `scheduleReconcile` saw a pending timer and returned; the old timer then
   fired, saw a stale generation and did nothing, and the session sat in
   "syncing" forever. Timers and the `reconciling` guard are now scoped to the
   current generation, and every generation change cancels the pending timer.
   `tests/connection.test.js` has the regression test.
6. **`utimes` takes seconds as a double**: an mtime of …123 ms reads back as
   …122.9999. States round mtimes (`roundMtime`), never truncate them, or every
   received file would look modified forever.
7. **A reconciliation must not reschedule itself from inside** (a permanently
   refused upload would loop). `scheduleReconcile` ignores requests while one
   runs; the pass returns whether another is needed, bounded by
   `MAX_RECONCILE_RETRIES`.
8. **A clean host shutdown is not a crash.** `app.close()` stops hosting, which
   sends `bye host_stopped`, so the peer ends in `stopped`, not
   `reconnecting`. To simulate a crash, close the server's connections.
9. **Keep-alive sockets keep `node --test` processes alive.** Close servers
   with `closeAllConnections()` (the SSE and NDJSON streams never end by
   themselves) and use `agent: false` for one-off requests in tests.
10. **`fetch` cannot accept one specific self-signed certificate** nor report
    which one it saw; the instance-to-instance client is built on
    `node:http`/`node:https` for that reason.
11. **`pkill -f "node src/index.js"` kills your own shell** when run from a
    shell whose command line contains that text. Use a pattern like
    `pgrep -f "node [s]rc/index.js"`.
12. **A sticky footer over a long form hid step 3** of the sync screen. The
    form actions are static now.
13. **An author `display` beats the `hidden` attribute.** `base.css` has
    `[hidden] { display: none !important; }`; keep it.
14. **Subtree operations must scale with the subtree.** `FileIndex` keeps a
    parent -> children map (with virtual nodes for ancestors that are not
    entries themselves) so `descendants`, `deleteTree` and `rekey` do not scan
    the whole index; removals are grouped under their top-most ancestor in one
    pass; paths are sorted with `sortWirePaths` (one key per path) instead of a
    comparator that splits both strings on every comparison. Together these
    took the detection of a deleted 15 000-entry tree from 13 s to about 3 s,
    most of which is now chokidar's own event handling.

---

## 6. Tests

```bash
npm test                                  # everything, ~16 s
node --test tests/sync.test.js            # one file
REPTILE_SKIP_BROWSER_TESTS=1 npm test     # skip the Chromium pass
REPTILE_TEST_LOG=debug npm test           # show the instances' logs
```

| File | Tests | Covers |
| --- | --- | --- |
| `lib.test.js` | 41 | IPv4 math, subnets, interface filtering, wire paths and their fast sort, NDJSON, queues, event bus, PIN rules, entry states, the index and its scaling, reporters |
| `startup.test.js` | 13 | flags, default port 55667, the free-port walk and its limits |
| `cert.test.js` | 7 | openssl output, names, key match, TLS handshake, replacement on every start |
| `discovery.test.js` | 14 | ping endpoint, probe, discovery, self-exclusion, incompatible protocols, the scan switch, manual check |
| `paths.test.js` | 17 | host and sync path validation, the content tree |
| `selection.test.js` | 16 | selection rules, enforcement on every peer operation, renames on the host |
| `planner.test.js` | 21 | every reconciliation rule |
| `watcher.test.js` | 12 | the operations derived from real filesystem changes |
| `sync.test.js` | 30 | initial sync, live sync both ways (create, modify, rename, delete, files and directories), conflicts, safety |
| `pin.test.js` | 9 | right/wrong PIN, unlimited retries, change while connected and resume |
| `connection.test.js` | 19 | one peer, busy, timeouts, protocol mismatch, stop hosting, reconnection, mode rules |
| `https.test.js` | 4 | HTTPS end to end, PIN flow, certificate pinning |
| `http.test.js` | 13 | static files, API, SSE, peer authentication, the guard |
| `browser.test.js` | 3 | the whole control panel flow in headless Chromium, HTTPS, phone layout |

`tests/helpers/instances.js` starts isolated instances on ephemeral ports with
temporary certificate directories, discovery off (or limited to loopback and
explicit ports), fast watcher timings and fast heartbeats (`config.timing`).
`tests/helpers/browser.js` is the dependency-free Chromium driver.

**When you change behaviour, add a test that would have failed before.** Check
that it does fail without the fix: two layers of protection can make a test
pass for the wrong reason (it happened with item 5 above).

---

## 7. Conventions

- ES modules everywhere, `.js` extensions in imports, 2-space indent, single
  quotes, semicolons, ~120-column soft limit.
- JSDoc on exported functions; comments explain *why*, not *what*.
- Domain errors are `AppError` (`src/domain/errors.js`) with a machine `code`
  and an HTTP `status`; routes never build error bodies by hand.
- Never `innerHTML` in the client; build nodes with `h()` from
  `public/js/core/dom.js`.
- Every control panel mutation sends `application/json` (the guard requires
  it).
- Run `npm test` before declaring anything done.

## 8. Deliberate non-goals

Do not add these without being asked. Each contradicts something above.

- Persisting anything (settings, the PIN, the sync base) between runs.
- More than one peer per hosted directory, or hosting several directories in
  one process (run another process instead).
- Following symbolic links, or syncing them as links.
- Conflict copies (`file.sync-conflict-…`); the newer version wins.
- A stronger authentication scheme: the PIN is symbolic by specification.
- Any npm package besides chokidar, a build step, or a front-end framework.
