# Reptile (Node.js) — maintenance guide

This file applies to `reptile/node/`: the Node.js implementation, and the
control panel in `public/`, which the Rust implementation embeds. **Read
[`../CLAUDE.md`](../CLAUDE.md) first**: it holds what both implementations
share — the product's hard constraints, the wire protocol, and the details
that break interoperability when changed. `README.md` here covers running
this implementation; `AGENTS.md` only points here.

---

## 1. Hard constraints (this implementation)

The product-wide ones are in `../CLAUDE.md` section 1. On top of them:

- **This implementation is the twin of `../rust`; change both together.** Any
  adjustment asked of Reptile is applied to the Rust implementation in the same
  change, kept as faithful as the languages allow (see `../CLAUDE.md` section 1).
  Only mechanism differs (the event loop vs threads), listed in `../rust/CLAUDE.md`
  section 4; behaviour, rules and tests mirror Rust's. A Windows-only fix still
  gets its Rust twin (guarded by `#[cfg(windows)]`).
- **Communicate with the user in Spanish. Write code, comments, documentation
  and interface text in English.** (Repository-wide convention.)
- **No npm dependencies.** None, in any layer, including dev and test
  dependencies. The test suite uses `node:test`; the browser tests drive
  Chromium over `--remote-debugging-pipe` precisely so they need no WebSocket
  package. The disk is watched with `fs.watch`; the certificate comes from the
  system `openssl`; the HTTP client, router, NDJSON stream, SSE hub and front
  end are all hand-written. Do not "simplify" any of them by adding a package.
  (Reptile 1.0 used chokidar; section 5 says why it went.)
- **The front end is plain HTML, CSS and ES modules** served as-is from
  `public/`. No framework, bundler, transpiler, CDN or build step. It is
  shared: the Rust build embeds these files, so whatever JSON a view reads must
  come out of both servers.
- **`npm start -- --https` mints a NEW certificate on every start** and
  replaces the one in `cert/`.
- **The version is `../version.txt`** (`src/lib/paths.js`, `PRODUCT_ROOT`),
  shared with Rust. `package.json`'s `version` mirrors it for tidiness only.

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
| Filesystem | `src/fs/` | `lib`. Entry states, walking, path validation, safe mutations, the index, the watcher and its `fs.watch` layer. No network, no rules. |
| Domain | `src/domain/` | `lib`, `fs`. **All business rules**: hosting, syncing, discovery, selection, planner, PIN, modes, protocol names. |
| Peer | `src/peer/` | `lib`, `domain/protocol.js`. The syncing side's HTTP client and the discovery probe. |
| HTTP | `src/http/` | `domain`. Router, guard, SSE, static files, route plugins. Never touches the disk itself. |
| Reporters | `src/reporters/` | The event bus only. |
| Client | `public/js/` | The HTTP API and the SSE stream. |

The domain never imports a transport. `app.js` injects the two it needs:
`peerFactory` (creates `src/peer/client.js` clients) and `probe`
(`src/peer/probe.js`). That is what makes the services testable and keeps a
second transport possible.

**Where to put a rule:** in `src/domain/`, and in `../rust/src/domain/` too.
The HTTP routes only translate requests into service calls.

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
   `{ access: 'ui' | 'peer' | 'public' }` (default `'ui'`, guarded). The Rust
   twin is `../rust/src/http/routes/` (`PLUGINS`).
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
(host name + MACs, `../CLAUDE.md` 4.2) used only to refuse syncing a directory
into itself on the same computer, whichever implementation the other side runs.
`VIRTUAL_INTERFACE` (`src/lib/net.js`) matches by name; on Windows
`os.networkInterfaces()` is keyed by the adapter *friendly name*, so the regex
lists `zerotier|virtualbox|vmware` (Hyper-V/WSL match through `veth`) on top of
the Linux short names. Keep it in sync with Rust's `VIRTUAL_PREFIXES`. The
fingerprint uses every MAC, not this filter, so editing the list never changes
the fingerprint.

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
loopback and the LAN keeps its LAN address. The status bar switch is
`POST /api/discovery { enabled }`; turning it off aborts both loops.

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
  as soon as a watcher batch looks at a path that appeared (`onRawAdd`, before
  anything inside it is examined) and again in `handleLocalOps`;
- things moved OUT of an unchecked directory follow their new location (they
  were not individually unchecked).

The inside of an excluded directory is not even watched (`ignoreInside`), but
its parent is, so renaming the excluded directory itself is seen. Every peer
operation goes through `sharedPath()`, which answers `403 not_shared`. A peer
deleting or renaming a shared directory that contains unchecked items gets a
partial result: `removeTree` / `moveTreeSelective` in `src/fs/mutate.js` leave
the unchecked content (and its directories) in place, and the peer reconciles.

**Locking.** One mutex per share serialises the watcher's batches and every
commit made for the peer. A received file is written to a temp file outside the
lock, then, under the lock, the index is updated FIRST and the file renamed into
place. The notifications that follow find the index already matching and
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
  was committed, never optimistically.
- **Reconciliation** (`reconcile`): fetch the manifest, walk the local tree,
  hash same-size files whose mtime differs and whose difference the base cannot
  explain, run the planner, execute deletions (deepest first), then
  directories (shallowest first), then transfers (8 in parallel). It runs on
  every hello, after conflicts or refused operations (bounded retries).
- **The local watcher starts after the first reconciliation**, followed by a
  full `rescan()` that catches anything changed in the meantime: every file a
  first sync writes would otherwise come back as a notification to examine
  and discard.
- **Live, host → peer**: `ops` messages on the stream. `applyRemoteOne`
  applies an operation only when the local path is still in the base state;
  otherwise it schedules a reconciliation and lets the planner decide.
- **Live, peer → host**: watcher batches go out through `pushLocal`: writes
  as `PUT /api/peer/file` (one by one, with `Expect: 100-continue`), everything
  else batched in `POST /api/peer/ops`, preserving order.
- **Reconnection**: exponential backoff (1 s → 10 s); ping first (a different
  UUID means the host restarted: stop), then reopen the stream with the old
  token, or with the remembered PIN if the host forgot the session. A refused
  PIN switches to `pin_required`.

### 3.5 The planner

`src/domain/planner.js`, pure. Per path, with L (local), R (remote), B (base):
equal → nothing; only one side changed since B → that side wins; both changed
or no base → a modification beats a deletion, the newer mtime wins (tie: host),
file-vs-directory is a conflict left alone (and everything below it frozen).
Afterwards, directories are made consistent. Without a base (first
connection) nothing is ever deleted: it is a merge.

### 3.6 Change detection

Two files:

- `src/fs/dirWatch.js` turns `fs.watch` notifications into **hints** (paths
  that may have changed). On Linux it keeps one non-recursive `fs.watch` (one
  inotify watch) per directory, adds watches as the batch discovers
  directories and releases them when they vanish; on Windows and macOS it uses
  ONE recursive `fs.watch` on the root (native there). Node's own recursive
  mode is not used on Linux: it is built on per-file watching.
- `src/fs/watcher.js` debounces the hints into batches (`quietMs` after the
  last, at most `maxWaitMs` after the first), lstat's every hinted path and
  diffs it against the index in three phases:
  - **A. renames**: a path whose inode belongs to an indexed path that is gone
    is a rename (directories first, so their children then compare equal);
  - **B. additions, modifications, replacements** (a file replaced by a
    directory yields the removal and the creation, in that order);
  - **C. removals**, held for `renameWindowMs` (the other half of a rename may
    arrive late) and collapsed so a deleted tree is one `rmdir`.

A directory that just got its own watch is walked (hint 2): entries created
before the watch existed produced no event. Files younger than `stabilityMs`
are looked at again after a pause (hint 3), and the whole tree is compared
every five minutes (hint 4). Operations carry the new local `state` (with
inode) so the owner can commit them; `reindex` operations (same content, new
inode) are local bookkeeping and never sent.

### 3.7 The PIN

`src/domain/pin.js`: exactly four digits, generated with `crypto.randomInt`,
compared in constant time. No attempt limit, by specification. A "random" PIN
change always yields a different PIN; setting the same PIN again is a no-op.

### 3.8 Certificates and TLS

`src/lib/cert.js` runs `openssl req -x509` with a throw-away config file, EC
P-256 by default with an RSA fallback, `CA:FALSE`, `serverAuth`, SANs for
localhost, the host name, `<host>.local`, loopback and every LAN address.
Files are written under temporary names and renamed into place. Each process
keeps the certificate it generated in memory. Peers connect with
`rejectUnauthorized: false` and pin the fingerprint seen at `connect`.

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
`#/sync?uuid=`). `public/js/core/dom.js` builds every element with
`textContent`; there is deliberately no way to insert raw HTML, because host
names and file names come from other machines.

---

## 4. Wire protocol

In `../CLAUDE.md` section 4, shared with the Rust implementation. One detail
specific to this server: uploads' `Expect: 100-continue` is handled by the
`checkContinue` event; the upload route opts out of the automatic
`100 Continue` with `{ manualContinue: true }` and every other route gets it
from `app.js`.

---

## 5. Things that cost time to discover

Every item was a real bug or trap during development. The fix is in place; the
note is so nobody reintroduces it.

1. **chokidar could lose a file for good, and cost most of the CPU.** When two
   reads of the same directory overlapped, a stale read could "remove" a file
   a newer read had just added, so it was never reported (nor, later, its
   deletion). And it re-read the whole directory and stat'ed every entry on
   each notification: on the receiving side of a live sync that was more than
   half of the CPU time. Reptile 1.1 dropped it for `fs.watch` hints
   (`dirWatch.js`): 2 000 files received live went from 16 s to 2 s of CPU,
   and memory with 20 000 files watched from 355 MB to 160 MB. Do not go back
   to a watcher that re-reads directories per event.
2. **inotify names the watched directory itself** for events that concern it
   (deleted, moved): `fs.watch` then reports the directory's basename as if
   it were a child. Both candidates are touched; an unchanged path costs one
   lstat.
3. **Watch first, list second.** A new directory's watch must exist before
   its content is read, or a file created in between is never reported.
   `expand()` adds the watch, then lists.
4. **A renamed directory keeps its inotify watch** (watches follow inodes),
   but its events would be attributed to the old path. The batch gives the new
   location its own watches and releases the old path's; a test checks that
   nothing is attributed to the old name.
5. **A watch on a subdirectory stops Windows from renaming the parent**, which
   is one more reason Windows uses a single recursive watch on the root.
6. **A deferred file must not spin the batch loop.** Files younger than
   `stabilityMs` are put back for a retry without a touch time; `reschedule`
   used to compute a due time from that zero, fire at once, and re-examine
   them up to 50 times in a row (28 batches for 300 fresh files). The retry
   now waits for `nextRetryDue`; `tests/watcher.test.js` has the regression
   test.
7. **A request whose `AbortSignal` is already aborted** used to be destroyed
   before its `'error'` listener existed, which crashed the process with an
   uncaught exception. `httpRequest` now refuses to create such a request, and
   every response gets a no-op `'error'` listener.
8. **A reconciliation timer from an older connection blocked the new one**:
   `scheduleReconcile` saw a pending timer and returned; the old timer then
   fired, saw a stale generation and did nothing. Timers and the `reconciling`
   guard are now scoped to the current generation.
   `tests/connection.test.js` has the regression test.
9. **`utimes` takes seconds as a double**: an mtime of …123 ms reads back as
   …122.9999. States round mtimes (`roundMtime`), never truncate them, or every
   received file would look modified forever.
10. **A reconciliation must not reschedule itself from inside** (a permanently
    refused upload would loop). `scheduleReconcile` ignores requests while one
    runs; the pass returns whether another is needed, bounded by
    `MAX_RECONCILE_RETRIES`.
11. **A clean host shutdown is not a crash.** `app.close()` stops hosting, which
    sends `bye host_stopped`, so the peer ends in `stopped`, not
    `reconnecting`. To simulate a crash, close the server's connections.
12. **Keep-alive sockets keep `node --test` processes alive.** Close servers
    with `closeAllConnections()` and use `agent: false` for one-off requests.
13. **`fetch` cannot accept one specific self-signed certificate** nor report
    which one it saw; the instance-to-instance client is built on
    `node:http`/`node:https` for that reason.
14. **`pkill -f "node src/index.js"` kills your own shell** when run from a
    shell whose command line contains that text. Use a pattern like
    `pgrep -f "node [s]rc/index.js"`.
15. **A sticky footer over a long form hid step 3** of the sync screen. The
    form actions are static now.
16. **An author `display` beats the `hidden` attribute.** `base.css` has
    `[hidden] { display: none !important; }`; keep it.
17. **Subtree operations must scale with the subtree.** `FileIndex` keeps a
    parent -> children map (with virtual nodes for ancestors that are not
    entries themselves); removals are grouped under their top-most ancestor in
    one pass; paths are sorted with `sortWirePaths` (one key per path).

The next two were found testing on **real Windows 10**; both are shared rules,
fixed in Rust too (see `../rust/CLAUDE.md` section 5 items 10-11). They are
no-ops on Linux.

18. **Windows cannot replace a locked or read-only file, diverging silently**
    (`src/fs/mutate.js` `commit`, `src/domain/syncing.js` `download` /
    `applyRemoteOne`). `rename` over a read-only or exclusively-locked target
    fails on Windows (POSIX replaces it if the directory is writable). The peer
    used to set the index and move on, so the two sides diverged while reporting
    "live". Now `commit` clears the read-only attribute (`chmod … | 0o200`,
    Windows only: on POSIX the rename failed for another reason, and the file's
    permissions are left alone) and retries; if the commit still fails,
    `download` puts back the **base** the decision was made against and discards
    the temp file (keeping the new state, or forgetting the base, left the next
    reconciliation to go by mtime, which uploaded a stale local copy over an
    older one the host had just restored); and a failed live `write` calls
    `scheduleReconcile`, so a locked file converges once the lock is released.
19. **Names one OS cannot store loop the reconciler** (`src/fs/entry.js`
    `isOsRepresentable`, used by `src/domain/syncing.js` `isRejected`). A
    directory with names Windows cannot create (`a:b.txt`, `aux.txt`, a trailing
    dot, …) made the Windows peer re-reconcile every 2-3 s forever, and
    `trailing.` round-tripped (Windows stores it as `trailing`). Such paths are
    now skipped like unshared ones. It is Windows-only in effect (on Linux every
    name is representable) and complements the character filter already in
    `normalizeWirePath` (adds trailing dot/space and reserved device names).

---

## 6. Tests

```bash
npm test                                  # everything, ~15 s
node --test tests/sync.test.js            # one file
REPTILE_SKIP_BROWSER_TESTS=1 npm test     # skip the Chromium pass
REPTILE_TEST_LOG=debug npm test           # show the instances' logs
```

| File | Tests | Covers |
| --- | --- | --- |
| `lib.test.js` | 43 | IPv4 math, subnets, interface filtering (incl. Windows adapter friendly names), wire paths and their fast sort, NDJSON, queues, event bus, PIN rules, entry states and `isOsRepresentable`, the index and its scaling, reporters |
| `startup.test.js` | 13 | flags, default port 55667, the free-port walk and its limits |
| `cert.test.js` | 7 | openssl output, names, key match, TLS handshake, replacement on every start (the 0o600 key-mode check runs off Windows only) |
| `discovery.test.js` | 14 | ping endpoint, probe, discovery, self-exclusion, incompatible protocols, the scan switch, manual check |
| `paths.test.js` | 17 | host and sync path validation, the content tree (casing compared case-insensitively on Windows; the `chmod`-based permission cases skip on Windows) |
| `selection.test.js` | 16 | selection rules, enforcement on every peer operation, renames on the host |
| `planner.test.js` | 21 | every reconciliation rule |
| `watcher.test.js` | 17 | the operations derived from real filesystem changes; watches follow renamed and owner-created directories, are released, skip unshared insides; no retry busy loop |
| `sync.test.js` | 31 | initial sync, live sync both ways (create, modify, rename, delete, files and directories), conflicts, safety (including a commit that fails keeping its base; POSIX only) |
| `pin.test.js` | 9 | right/wrong PIN, unlimited retries, change while connected and resume |
| `connection.test.js` | 19 | one peer, busy, timeouts, protocol mismatch, stop hosting, reconnection, mode rules |
| `https.test.js` | 4 | HTTPS end to end, PIN flow, certificate pinning |
| `http.test.js` | 13 | static files, API, SSE, peer authentication, the guard |
| `mutate.test.js` | 2 | `commit` replaces a read-only file (Windows only), and leaves the file's permissions alone when it fails (POSIX only) |
| `browser.test.js` | 3 | the whole control panel flow in headless Chromium, HTTPS, phone layout |

229 in total. `tests/helpers/instances.js` starts isolated instances on
ephemeral ports with temporary certificate directories, discovery off (or
limited to loopback and explicit ports), fast watcher timings and fast
heartbeats (`config.timing`). `tests/helpers/browser.js` is the
dependency-free Chromium driver. Interoperability with Rust is tested from
`../rust/tests/interop.rs`.

Platform-specific assertions key off `process.platform` so a shared test keeps
its strict form on Linux; a few cases that cannot exist on Windows (POSIX
`chmod` making a directory unreadable/non-writable) are `skip`ped there with a
reason. The suite is green on real Windows 10 (`REPTILE_SKIP_BROWSER_TESTS=1`
when there is no Chromium): 0 failures, the POSIX-only cases skipped.

**When you change behaviour, add a test that would have failed before.** Check
that it does fail without the fix: two layers of protection can make a test
pass for the wrong reason (it happened with item 8 above).

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
- Run `npm test` before declaring anything done (and `cargo test` in
  `../rust` when the change touches anything in `../CLAUDE.md` section 4).

## 8. Deliberate non-goals

The product-wide ones are in `../CLAUDE.md`. Here: any npm package, a build
step, or a front-end framework.
