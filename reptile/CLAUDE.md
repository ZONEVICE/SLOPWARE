# Reptile — maintenance guide

This file applies to the whole `reptile/` directory and is the entry point for
an assistant arriving with no conversation context: Claude Code, Codex, or any
other coding assistant. `AGENTS.md` only points here. Read `README.md` first
for user-facing behaviour.

Reptile has **two implementations of one product**: Node.js in `node/` and Rust
in `rust/`. This file holds what they share; each has its own guide for its
code:

- [`node/CLAUDE.md`](node/CLAUDE.md): the Node.js implementation, and the
  control panel in `node/public` (shared by both).
- [`rust/CLAUDE.md`](rust/CLAUDE.md): the Rust implementation.

`prompts/init.md` keeps the prompts that produced Reptile. Treat them as
history, not as a specification to re-execute. `LICENCE.txt` is an MIT
licence; do not add per-file licence headers or change its terms.

---

## 1. Hard constraints

These are not preferences. Breaking one of them breaks the product.

- **Communicate with the user in Spanish. Write code, comments, documentation
  and interface text in English.** (Repository-wide convention.)
- **The two implementations stay wire-compatible.** A Rust instance and a
  Node.js instance must find, host for and sync with each other, over HTTP and
  HTTPS, in both directions. Any change to section 4 is made in both, and
  `rust/tests/interop.rs` must pass.
- **One control panel.** The front end lives in `node/public` (plain HTML,
  CSS and ES modules, no build step). The Node.js server serves it from disk;
  the Rust build embeds the same files. The JSON the panel reads (section 4.3)
  is identical in both implementations.
- **One version.** `version.txt` (SemVer 2, no trailing newline) is the
  product version. Node.js reads it at startup; the Rust build reads it and
  refuses to build unless `rust/Cargo.toml` says the same. Bump both together:
  MINOR for a backwards-compatible feature, PATCH for a fix, MAJOR for
  anything that breaks the protocol, the flags or the panel's API (and then
  also `PROTOCOL_VERSION` when the wire protocol changes).
- **Dependencies are deliberate.** Node.js: none at all, in any layer, tests
  included. Rust: `rustls` (ring backend), `ring`, `serde_json`, `libc`,
  `windows-sys`, and nothing else. Ask before adding one.
- **Nothing about Reptile is persisted.** Hosted directory, PIN, sessions,
  sync bases, discovered instances: memory only. The only things written to
  disk are the synchronised files, Reptile's own `.reptile-<hex>.tmp` transfer
  files, and the certificate for `--https`.
- **`--https` mints a NEW certificate on every start** and replaces the
  previous one. Required behaviour, not an optimisation target.
- **A busy port is not an error.** Walk upwards from 55667 (or `--port`) on
  "address in use" only; port 0 passes through.
- **Unchecked items never leave the host and are never modified by the
  peer.** Every outgoing path and every incoming operation goes through the
  selection.
- **An instance is in one mode at a time** (idle, hosting, syncing); **one peer
  per hosted directory**; HTTP only talks to HTTP, HTTPS to HTTPS.
- **Never mistake a vanished root for deletions.** If the watched directory
  disappears, stop; never propagate "everything was deleted".

---

## 2. Layout

```
version.txt        product version (SemVer), shared
node/              Node.js implementation; node/public is THE control panel
rust/              Rust implementation; embeds ../node/public at build time
bench/bench.mjs    black-box benchmark and end-to-end check, either implementation
prompts/           the prompts that produced Reptile
xtest/           cross-machine test helper, playbook and the Windows 10 results (see its README)
```

Both implementations have the same layers, with the same names where the
languages allow: `config` -> helpers (`lib` / `util`) -> `fs` -> `domain` ->
`peer` + `http` -> `app` (composition root), plus `reporters`. Business rules
live in `domain` in both. When a rule changes, change it in both and say so in
both guides.

---

## 3. What runs where

Whatever the implementation, one process holds: the HTTP(S) server (control
panel, its API, the peer API), the discovery loops, at most one hosted share
or one syncing engine, and the change detector of whichever directory it
hosts or syncs. The domain is the same; `node/CLAUDE.md` section 3 describes it
in depth (identity, discovery, hosting and the selection, the syncing engine,
the planner, change detection, the PIN, TLS, the guard, the client), and
`rust/CLAUDE.md` describes where the Rust code differs in mechanism (threads
instead of an event loop) but not in rules.

---

## 4. The contract between implementations

### 4.1 Wire protocol

All paths on the wire are **wire paths**: relative to the synced root, `/`
separated, no `.`/`..`/empty segments. Every incoming path is normalised and
re-checked for containment, and writes never go through a symlink.

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/ping` | none | `{ app: 'reptile', version, protocolVersion, uuid, hostname, protocol, port, mode, hosting: { id, name, connected } \| null }` |
| `POST /api/peer/connect` | PIN | `{ pin, protocol, peer: { uuid, hostname, machine, localPath } }` → `{ token, protocolVersion, share: { id, name }, host: { uuid, hostname } }` |
| `GET /api/peer/stream` | token | NDJSON: `hello`, `ops`, `heartbeat`, `bye` |
| `GET /api/peer/manifest` | token | `{ share, entries: [{ path, kind, size, mtimeMs }] }` (shared only) |
| `POST /api/peer/hashes` | token | `{ paths }` (≤ 20 000) → `{ hashes: { path: sha256 } }` |
| `GET /api/peer/file?path=` | token | raw bytes; `x-reptile-size`, `x-reptile-mtime` |
| `PUT /api/peer/file?path=` | token | raw body; `x-reptile-size`, `x-reptile-mtime`, optional `x-reptile-base-size`/`-base-mtime` |
| `POST /api/peer/ops` | token | `{ ops: [...] }` → `{ results: [{ ok, partial?, missing?, code?, message? }] }` |
| `POST /api/peer/heartbeat` | token | `{ phase, progress }` → `{ ok: true }` |
| `POST /api/peer/disconnect` | token | leave |

Tokens travel as `Authorization: Bearer <token>`. Operations:
`{ op: 'mkdir', path }`, `{ op: 'write', path, size, mtimeMs }` (stream only;
uploads use `PUT`), `{ op: 'unlink', path, base? }`, `{ op: 'rmdir', path }`,
`{ op: 'rename', from, to, kind, base? }`. `base` is the sender's last synced
`{ kind, size, mtimeMs }`; the receiver refuses (`409 conflict`) when its own
copy differs, and the sender reconciles.

Stream messages: `{ type: 'hello', protocolVersion, share, host }` first, then
`{ type: 'ops', ops }`, `{ type: 'heartbeat', at }` every 5 s, and
`{ type: 'bye', reason, message }` with reason `pin_changed`, `host_stopped`,
`replaced` or `timeout`. A peer treats 16 s of silence as a dead stream; a host
drops a peer silent for 20 s.

Error bodies are always `{ error: { code, message, details? } }`. Codes a peer
acts on: `pin_invalid`, `busy`, `not_hosting`, `protocol_mismatch`,
`same_directory`, `not_shared`, `conflict`, `unauthorized`.

### 4.2 Details that break interoperability when changed

Each of these was checked against the other implementation; change one side
only and the two stop understanding each other.

1. **Modification times are whole milliseconds, rounded the JavaScript way**:
   `Math.round(seconds * 1e3 + nanoseconds / 1e6)` in double precision. A
   receiver stamps the sender's mtime on every file it writes, and states are
   compared by size and mtime.
2. **The machine fingerprint** is `sha256("<hostname>|<sorted MACs joined by
   ','>")`, first 32 hex digits, with the MACs of every interface that is up
   and has an address (libuv's rules), zero MACs left out. Both sides must
   compute the same value on one computer, or the same-directory check fails.
3. **Keep-alive responses carry `Keep-Alive: timeout=5`.** Node.js's HTTP
   agent reads it and retires idle sockets a second early; without it the agent
   reuses sockets the server already closed.
4. **Uploads use `Expect: 100-continue`**: the host decides from the headers
   (`unchanged`, `conflict`, `not_shared`) before any byte of the body. A host
   that answers without `100 Continue` closes the connection.
5. **`?path=` is encoded like `encodeURIComponent`** and decoded like
   `URLSearchParams`.
6. **Certificates are pinned by the colon-separated uppercase SHA-256 of the
   DER** seen at `connect`; a different one later fails with
   `certificate_changed`. Pins never travel; each client checks its own.
7. **HTTP is spoken to HTTP and TLS to TLS.** Discovery tells them apart by
   trying the instance's own protocol first and the other one when the error
   smells of a mismatch (a reset, or a failed handshake).
8. **The two OS-specific lists must agree between implementations**, because each
   decides what a peer advertises and syncs:
   - *Virtual interfaces* — `VIRTUAL_PREFIXES` (`rust/src/util/net.rs`) and
     `VIRTUAL_INTERFACE` (`node/src/lib/net.js`): which adapters are skipped when
     choosing the LAN address and scan range. Includes Windows adapter friendly
     names (`zerotier`, `virtualbox`, `vmware`); `veth` already covers Hyper-V/WSL.
   - *Names the local OS cannot store* — `is_os_representable`
     (`rust/src/fs/entry.rs`) and `isOsRepresentable` (`node/src/fs/entry.js`): a
     peer skips a wire path it cannot create (Windows reserved chars/names, a
     trailing dot or space), so it neither retries forever nor lets a munged name
     round-trip. Both are no-ops off Windows. If the two implementations disagree,
     a Rust and a Node instance on the same OS would sync a shared directory
     differently — change them together.

### 4.3 The control panel's API

`GET /api/state` and every `state` event on `GET /api/events` (server-sent
events, ~8/s at most) carry the same snapshot:
`{ identity, ui: { remote }, discovery, mode, hosting, syncing, serverTime }`.
The routes are `/api/discovery`, `/api/discovery/scan`, `/api/paths/check`,
`/api/paths/tree`, `/api/paths/suggest`, `/api/host`, `/api/host/pin`,
`/api/host/pin/suggest`, `/api/sync`, `/api/sync/inspect`, `/api/sync/pin`.
The exact shapes are whatever `node/public/js` reads; both implementations
produce them field for field (key order aside). The panel is guarded (only
this computer unless `--remote-ui`, no foreign Host/Origin, JSON bodies only);
peer routes and `/api/ping` are not.

---

## 5. Changing things

- **A rule or a behaviour:** change `domain` in both implementations, add a
  test in both, and update both guides.
- **The protocol or the panel's API:** section 4 first, then both
  implementations, then `rust/tests/interop.rs`. Bump the version (and
  `PROTOCOL_VERSION` for a breaking wire change).
- **The front end:** edit `node/public`; rebuild Rust to embed it (or run Rust
  with `REPTILE_PUBLIC_DIR=../node/public` while working on it).
- **Performance:** measure with `node bench/bench.mjs` for both before and
  after; it also verifies the trees byte for byte after every scenario.

Before declaring anything done:

```bash
cd node && npm test           # 229 tests (3 are Chromium; set REPTILE_SKIP_BROWSER_TESTS=1 without it)
cd rust && cargo test         # 153 tests on Linux, including interop with node/
cd rust && cargo clippy --all-targets   # clean, Linux and Windows targets
```

All three pass on Linux and on **real Windows 10**. Windows-only behaviour was
validated on a real machine, not Wine; anything touching a Windows code path
(file watching, the discovery probe, interface filtering, file ids, locked /
read-only / unrepresentable names, the firewall) is worth re-checking there. See
each implementation guide's section 5 for the Windows-specific traps.

---

## 6. Known gaps

Found testing on real Windows 10, or reviewing those results, and left open on
purpose: each needs a Windows machine to fix and to verify. Do not mistake them
for settled behaviour.

- **Paths longer than 260 characters** are not indexed on Windows (the file
  layer does not use `\\?\` extended paths), so such files are silently left
  out. Fixing it means extended-length paths throughout the file layer of both
  implementations.
- **Names that differ only in case** (`README` and `readme`) are one file on
  Windows. A Windows peer receiving both keeps one and keeps reconciling. A fix
  would skip the colliding ones on the peer: a rule over the whole set of
  paths, unlike `is_os_representable`.
- **A Windows host accepts names it cannot store as given**: a trailing dot or
  space, or a device name (`aux.c`). There, `normalizeWirePath` /
  `wire::normalize` refuse only the reserved characters. Windows strips the
  trailing dot or space, the stripped name travels back, and the peer's file
  ends up renamed. The peer side is covered by `is_os_representable` (4.2); the
  host side should refuse the same names.
- **A host whose upload fails to commit keeps the new state in its index**
  (both implementations), so it later announces a change that did not happen.
  Harmless (the manifest is read from disk and the peer keeps its base), but
  untidy; the peer side was fixed to put the base back.
- **Discovery from Windows** misses an instance on a host whose first scanned
  port is closed: Windows takes ~2 s to refuse a connection
  (`rust/CLAUDE.md` section 5, item 8).

---

## 7. Deliberate non-goals

Do not add these without being asked. Each contradicts something above.

- Persisting anything (settings, the PIN, the sync base) between runs.
- More than one peer per hosted directory, or several directories per process.
- Following symbolic links, or syncing them as links.
- Conflict copies (`file.sync-conflict-…`); the newer version wins.
- A stronger authentication scheme: the PIN is symbolic by specification.
- A third implementation's worth of drift: if the two disagree, one is wrong.
