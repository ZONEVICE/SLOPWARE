# Reptile (Rust) — maintenance guide

This file applies to `reptile/rust/`: the Rust implementation. **Read
[`../CLAUDE.md`](../CLAUDE.md) first**: it holds what both implementations
share — the product's hard constraints, the wire protocol, and the details
that break interoperability when changed. The rules themselves (hosting, the
selection, the engine, the planner) are described in depth in
[`../node/CLAUDE.md`](../node/CLAUDE.md) section 3; this crate implements the
same rules, so that description applies here too. This file covers what is
specific to Rust. `README.md` covers building, packaging and running;
`AGENTS.md` only points here.

---

## 1. Hard constraints (this implementation)

- **Communicate with the user in Spanish. Write code, comments, documentation
  and interface text in English.** (Repository-wide convention.)
- **Dependencies: `rustls` (ring backend, no aws-lc), `ring`, `serde_json`,
  `libc` (Unix), `windows-sys` (Windows). Nothing else**, dev-dependencies
  included. HTTP/1.1 (server and client), the router, the NDJSON stream, the
  SSE hub, the X.509 certificate and the filesystem watchers are hand-written;
  do not replace them with crates. `ring` rather than `aws-lc-rs` because it
  cross-compiles to Windows with nothing but `zig cc`.
- **No async runtime.** Standard threads: one per connection, one per timer,
  a few per service. A LAN tool with a handful of connections is simplest and
  lightest that way.
- **The control panel is `../node/public`**, embedded by `build.rs`
  (`REPTILE_PUBLIC_SRC` overrides the source; `REPTILE_PUBLIC_DIR` serves from
  disk at run time). Never fork a copy into this crate.
- **The version is `../version.txt`.** `build.rs` stops the build unless
  `Cargo.toml`'s `version` is the same string; it exposes it as
  `env!("REPTILE_VERSION")`.
- **The JSON is the Node.js implementation's**, field for field (key order
  aside): the control panel reads it, and Node.js peers parse it. Check
  `../node/src` when in doubt; `tests/interop.rs` checks the protocol.
- MSRV 1.83. `cargo clippy --all-targets` clean on Linux and on
  `x86_64-pc-windows-gnu`; `cargo fmt` with the crate's `rustfmt.toml`
  (120 columns, like the Node.js code).

---

## 2. Architecture

The same layers as the Node.js implementation; dependencies flow one way:

```
config ─▶ util ─▶ fs ─▶ domain ─▶ peer (outgoing HTTP) ─┐
                          │                             ├─▶ app.rs wires them
                          └─ events ─▶ http (routes, SSE)┘    together
                                    └▶ reporters
```

| Module | Node.js twin | Holds |
| --- | --- | --- |
| `util/` | `src/lib/` | clocks (`time`: JS-compatible rounding), ids, logger, the event bus, wire paths, network interfaces and IPv4 math (`net`), URL encoding, OS facts (`sys`: host name, data dir, signals), port walk (`listen`), the self-signed certificate (`cert`: DER by hand, signed by ring), thread primitives (`threads`) |
| `fs/` | `src/fs/` | entry states (`entry`, with Windows file ids), the index, walking, hashing, safe mutations, path checks, OS change notifications (`os_watch`), the change detector (`watcher`) |
| `domain/` | `src/domain/` | all business rules; `transport.rs` declares the two transports the domain needs (`PeerApi`, `Probe`) |
| `peer/` | `src/peer/` | the peer client and the discovery probe, implementing `transport.rs` |
| `http/` | `src/http/` | message framing, connections and TLS, the server and the client, router, guard, SSE, embedded assets, route plugins |
| `reporters/` | `src/reporters/` | console messages |
| `app.rs`, `main.rs`, `config.rs` | `app.js`, `index.js`, `config.js` | composition root, entry point and banner, flags and environment |

`src/lib.rs` exposes every module so the integration tests in `tests/` can
build instances in process.

### Extension points

1. **HTTP routes**: a plugin is `fn register(router: &mut Router, deps:
   &Arc<Deps>)` in `src/http/routes/`; add it to `PLUGINS` in `mod.rs`. Each
   route declares `Access::Ui` (guarded), `Peer` or `Public`.
2. **Event subscribers**: a reporter is `fn(&Arc<EventBus>, &Logger) ->
   Subscription` in `src/reporters/`; add it to `REPORTERS`.
3. **Events**: a new event is a new variant of `util::events::Event`; there
   are no free-form names.

---

## 3. Threads and locks

The Node.js implementation leans on its single-threaded event loop; here the
same orderings are enforced with locks. Get these wrong and you get
deadlocks, not wrong answers.

- **Hosting** (`domain/hosting.rs`): each `Share` has a `disk` lock (index,
  selection, stats) — the equivalent of Node's per-share mutex: held for a
  whole watcher batch and for each peer operation — and a `session` lock.
  **Order: disk, then session; never the reverse.**
- **Syncing** (`domain/syncing.rs`): each `Engine` has a `disk` lock held by
  whoever touches the local disk (remote ops and reconciliations on the
  serial queue's thread, local batches on the watcher's thread), an `index`
  lock held briefly (the reconciliation's 8 transfer threads share the index),
  and an `st` lock for its state, never held across I/O. The stream reader
  thread never takes the disk lock: it queues `ops` and handles `hello`/`bye`
  at once, so a `bye` interrupts a long reconciliation (via the generation).
- **The watcher** (`fs/watcher.rs`): its thread calls `WatchOwner::batch`,
  which takes the owner's lock, then the watcher's `core`. `touch` and
  `rescan` take only `core` (and `inspect`, which takes the index lock but
  never the batch lock), so the engine may call `rescan` from inside a
  reconciliation.
- **Events are published after locks are released**, or with only locks no
  subscriber takes: subscribers (the SSE hub, the console reporter, the mode
  controller's listener) never call into a service that locks.
- **Every `Mutex` is taken with `Locked::locked()`** (`util/threads.rs`),
  which survives poisoning: a panic in one task must not stop syncing for
  good; the next reconciliation repairs whatever state it left.

---

## 4. Where the mechanism differs from Node.js

- **HTTP server** (`http/server.rs`): thread per connection, keep-alive 5 s
  with the `Keep-Alive: timeout=5` header, `Expect: 100-continue` answered
  lazily (the `100` goes out when the handler first reads the body; a route
  that refuses from the headers alone never asks for it, and the connection
  is closed). Streams (SSE, NDJSON) are chunked and end the connection.
- **HTTP client** (`http/client.rs`): pooled keep-alive connections per peer
  client, retired a second before the server's `Keep-Alive` hint and checked
  with a non-blocking peek before reuse; a request that gets no response byte
  on a reused connection is retried once on a fresh one. Uploads send their
  headers, wait for `100 Continue` (or a final answer), then exactly `size`
  bytes of the file.
- **TLS** (`http/tls.rs`): rustls both ways. The client accepts any
  certificate but still verifies the handshake signature against it, and
  reports the SHA-256 fingerprint for pinning. The certificate is generated in
  process (`util/cert.rs`), so `--https` needs no `openssl`; it goes to the
  per-user data directory (`util/sys.rs::data_dir`) unless `REPTILE_CERT_DIR`.
- **Change notifications** (`fs/os_watch.rs`): inotify, one watch per
  directory, on Linux; one recursive `ReadDirectoryChangesW` on the root on
  Windows; elsewhere none, and the watcher rescans every 2 s instead. The diff
  in `fs/watcher.rs` is the Node.js implementation's, phase for phase.
- **Windows file identity**: `fs/entry.rs` opens a handle per lookup for the
  volume serial and file id (the inode), and lists directories with
  `FileIdBothDirectoryInfo` (one handle per directory); FILETIME is converted
  to milliseconds exactly as libuv and Node.js do.
- **Interfaces and host name** (`util/net.rs`, `util/sys.rs`): `getifaddrs`
  on Unix, `GetAdaptersAddresses` on Windows, both filtered like libuv, so the
  machine fingerprint matches Node.js's on the same computer.
- **Shutdown**: SIGINT/SIGTERM (a `sigwait` thread, set up before any other
  thread exists) or the console's Ctrl+C/close (`SetConsoleCtrlHandler`) run
  `App::close`, which says `bye host_stopped` to a connected peer.

---

## 5. Things that cost time to discover

1. **Node.js agents trust `Keep-Alive: timeout=`.** Without the header the
   agent reused sockets this server had already closed after its idle timeout,
   and requests failed at random under load.
2. **`Watcher::close` must not wait for the watcher's thread.** The engine
   ends a session (`end`) from inside a reconciliation, holding the disk lock,
   while the watcher's thread may be waiting for that same lock to run a
   batch. Closing now only signals; a batch that started anyway finds the
   owner stopped and does nothing.
3. **Streams attach before they are written.** The peer stream registers its
   sink with the session before the response head goes out; if the client is
   already gone the stream function never runs. A drop guard (`Attached` in
   `routes/peer.rs`) detaches it either way.
4. **Rust's standard library needs Windows 10 APIs**:
   `bcryptprimitives.dll!ProcessPrng` (randomness) is missing from Wine 6, and
   so is `GetHostNameW`. The host name now comes from `GetComputerNameExW`
   (same answer, every Windows); for `ProcessPrng`, testing the `.exe` under
   Wine 6 needs a shim DLL next to it (see section 7). Real Windows 10/11 is
   fine.
5. **A file that is still being written must not spin the batch loop.** Found
   while porting the watcher: Node.js re-examined deferred files immediately,
   up to 50 times. Both implementations now wait `max(20, stability/2)` ms.
6. **Do not choose a free port and hand it to another process.** Between
   closing the probe socket and the other process binding it, an instance in a
   parallel test can take it (and the test then talks to the wrong instance).
   Start with `--port 0` and read the port from the banner, as
   `tests/interop.rs` and `../bench/bench.mjs` do.
7. **mtimes are rounded like JavaScript, in floating point**
   (`util/time.rs::mtime_ms`): an exact integer division disagrees with
   Node.js for timestamps right on a half-millisecond, and the two sides would
   see different states for the same file.

---

## 6. Tests

```bash
cargo test                                  # everything, ~15 s
cargo test --test interop                   # against ../node (needs node)
REPTILE_TEST_LOG=debug cargo test --test sync -- --nocapture
```

| Where | Tests | Covers |
| --- | --- | --- |
| unit tests in `src/` | 49 | wire paths, IPv4 math and interface filtering, the machine fingerprint, URL encoding, DER and the certificate, queues and timers, the event bus, entry states, the index and its scaling, the planner, the PIN, the selection, HTTP framing, the guard, configuration, the embedded panel |
| `tests/watcher.rs` | 17 | operations derived from real filesystem changes, watch bookkeeping |
| `tests/sync.rs` | 21 | initial sync, live sync both ways, conflicts, hashes, safety |
| `tests/connection.rs` | 25 | one peer, busy, timeouts, protocols, stopping, crashes, reconnection, modes, the PIN |
| `tests/selection.rs` | 10 | unchecked items on every peer operation and in a live sync |
| `tests/http.rs` | 10 | panel files, API, SSE, peer authentication, guard, keep-alive hint, port walk |
| `tests/https.rs` | 5 | HTTPS end to end, pinning, a new certificate on every start |
| `tests/discovery.rs` | 6 | ping, probe, discovery, incompatible protocols, the scan switch |
| `tests/interop.rs` | 7 | Rust peer of a Node.js host and the reverse, HTTP and HTTPS; PIN change; same-directory refusal across implementations; mutual discovery |

150 in total. `tests/common/mod.rs` starts isolated in-process instances on
ephemeral ports with temporary certificate directories, discovery off, fast
watcher timings and fast heartbeats. **When you change behaviour, add a test
that would have failed before**, and check that it does fail without the fix.

---

## 7. Packaging and Windows

`scripts/package.sh` cross-compiles with `cargo-zigbuild` (glibc 2.28 for the
Linux binary, MinGW for Windows) and builds the `.deb` with `cargo-deb` from
`[package.metadata.deb]` in `Cargo.toml`. Requirements are listed at the top
of the script; nothing needs root.

To try the Windows build on Linux under Wine 6, put a `bcryptprimitives.dll`
exporting `ProcessPrng` (a few lines of C calling `SystemFunction036`, built
with `zig cc -shared -target x86_64-windows-gnu ... -ladvapi32`) next to
`reptile.exe`. `../bench/bench.mjs --host-cmd "wine reptile.exe"
--host-windows` then syncs it against a Linux instance; this is how the
Windows watcher, file ids and FILETIME handling were checked.

---

## 8. Conventions and non-goals

- Doc comments explain *why*; module comments say what a file is for and how
  it connects. Errors that reach the user are `domain::errors::AppError`
  (machine `code`, HTTP `status`); routes never build error bodies by hand.
- `unsafe` only for FFI, each block with a `SAFETY:` comment.
- Non-goals: the product-wide ones in `../CLAUDE.md`, plus an async runtime,
  a web framework, or a second copy of the control panel.
