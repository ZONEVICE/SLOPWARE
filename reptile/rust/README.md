# Reptile — Rust implementation

> **This software was generated 100% using artificial intelligence** — specifically Claude Code + Opus 5.5, Max effort — on October 8, 2026, as a port of the Node.js implementation. The prompts are in [`../prompts/init.md`](../prompts/init.md). Post-creation adjustments draw on Claude Code + Opus 5.5, Max effort.

Reptile keeps one directory identical on two computers of the same local
network, in real time and in both directions, over HTTP or HTTPS. This is the
Rust implementation: one self-contained executable, the control panel
included, for Linux (Debian and others) and Windows 10/11.

It is wire-compatible with the Node.js implementation in [`../node`](../node):
a Rust instance and a Node.js instance find each other, host for each other
and sync with each other. What Reptile does, how to use the control panel and
how synchronisation behaves are in the product README,
[`../README.md`](../README.md).

## Install

**Debian, Ubuntu, Linux Mint** (amd64, Debian 10 or newer):

```bash
sudo apt install ./reptile_1.1.0-1_amd64.deb     # installs /usr/bin/reptile
reptile
```

**Any other Linux** (x86_64, glibc 2.28 or newer): the plain binary needs
nothing else.

```bash
chmod +x reptile-1.1.0-linux-x86_64
./reptile-1.1.0-linux-x86_64
```

**Windows 10 and 11** (x86_64): unzip `reptile-1.1.0-windows-x86_64.zip` and
run `reptile.exe` from a terminal (or double-click it). The first time, Windows
Firewall asks whether to allow it: allow it for the network you are on
(Windows calls many home networks "Public"), or other computers cannot reach
it. A dismissed prompt leaves a rule that blocks `reptile.exe`, and a block
rule wins over any allow rule. Check *Windows Defender Firewall → Allow an app
through Windows Firewall* if peers cannot connect.

The zip also holds two scripts that settle this for you. With them next to
`reptile.exe`, run `firewall-add-rules.bat` (it asks for administrator rights):
it deletes every inbound rule Windows created for that `reptile.exe`, blocking
ones included, and adds one allow rule for all network profiles.
`firewall-remove-rules.bat` deletes them again, and both accept `check` to only
list the rules. The rules are tied to the full path of the `.exe`, so run the
script again if you move it.

These files are built by `scripts/package.sh` (below) into `dist/`.

## Run

```bash
reptile                        # HTTP, port 55667 (or the next free one)
reptile --https                # a brand-new self-signed certificate, then HTTPS
reptile --port 8080            # start at another port
reptile --no-scan              # start with network discovery switched off
reptile --help                 # every option
reptile --version
```

Open the control panel URL it prints, `http://localhost:55667` by default, on
the same computer. Ctrl+C stops it cleanly: a connected peer is told that
hosting stopped. Every flag and variable is listed in the product README; this
implementation also reads:

| Variable | Default | Meaning |
| --- | --- | --- |
| `REPTILE_CERT_DIR` | see below | Where `--https` writes its certificate |
| `REPTILE_PUBLIC_DIR` | embedded | Serve the control panel from this directory instead of the copy built in (for front-end work) |

`--https` generates a new certificate (ECDSA P-256, self-signed) on **every**
start, in process (no `openssl` needed), and writes it as `cert.pem` and
`key.pem` to `$XDG_DATA_HOME/reptile/cert` (usually
`~/.local/share/reptile/cert`) on Linux, or `%LOCALAPPDATA%\Reptile\cert` on
Windows, replacing the previous one.

## Build

```bash
cargo build --release          # target/release/reptile
cargo test                     # 150 tests, about 15 seconds
```

Rust 1.83 or newer. The build embeds the control panel from `../node/public`
(it is shared with the Node.js implementation, so build from a full checkout
of `reptile/`) and reads the version from `../version.txt`, which must match
`version` in `Cargo.toml`; the build stops if they differ.

### Release packages

```bash
scripts/package.sh
```

builds, into `dist/`, the Linux binary (linked against glibc 2.28, so it runs
on Debian 10 and newer), the `.deb`, and the Windows zip. Cross-compilation
goes through [zig](https://ziglang.org) via `cargo-zigbuild`, so nothing is
installed system-wide:

```bash
rustup target add x86_64-unknown-linux-gnu x86_64-pc-windows-gnu
cargo install --locked cargo-zigbuild cargo-deb
# and zig 0.13 or newer on PATH: https://ziglang.org/download/
```

The `.deb` also needs `dpkg-dev`, present on any Debian-family system. The
Windows build is cross-compiled for the `x86_64-pc-windows-gnu` target. On
Windows itself, the MSVC toolchain (`cargo +stable-x86_64-pc-windows-msvc`)
builds it and passes the whole test suite; the GNU toolchain needs a MinGW
`gcc` on `PATH`.

## Tests

```bash
cargo test                       # everything
cargo test --test sync           # one file
cargo test --test interop        # against the Node.js implementation
REPTILE_TEST_LOG=debug cargo test -- --nocapture
```

| File | Covers |
| --- | --- |
| unit tests (`src/`) | wire paths, IPv4 math and interfaces, the machine fingerprint, URL encoding, certificates, queues and timers, entry states, the index, the planner, the PIN, the selection, HTTP framing, the guard, configuration |
| `tests/watcher.rs` | the operations derived from real filesystem changes |
| `tests/sync.rs` | initial sync, live sync both ways (create, modify, rename, delete, files and directories), conflicts, safety |
| `tests/connection.rs` | one peer, busy, timeouts, protocol mismatch, stopping, crashes, reconnection, mode rules, the PIN |
| `tests/selection.rs` | unchecked items on every peer operation and in a live sync |
| `tests/http.rs` | control panel files, API, server-sent events, peer authentication, the guard, the port walk |
| `tests/https.rs` | HTTPS end to end, certificate pinning, a new certificate on every start |
| `tests/discovery.rs` | ping, probe, discovery, incompatible protocols, the scan switch |
| `tests/interop.rs` | a Rust peer of a Node.js host and the reverse, over HTTP and HTTPS; PIN change; same-directory refusal; mutual discovery |

The interoperability tests start `node ../node/src/index.js`; they skip
themselves when Node.js is not installed.

## Dependencies

Four crates, each for something that is not reasonable to write by hand:

- `rustls` (with the `ring` backend): TLS, client and server.
- `ring`: SHA-256, randomness, and the ECDSA key that signs the certificate.
- `serde_json`: JSON.
- `libc` (Unix) and `windows-sys` (Windows): the system calls the standard
  library does not expose (network interfaces, inotify, file ids, signals).

Everything else is hand-written on the standard library, like the Node.js
implementation: the HTTP/1.1 server and client, the router, the event stream,
the self-signed X.509 certificate, the filesystem watchers (inotify on Linux,
ReadDirectoryChangesW on Windows). There is no async runtime: a LAN tool with
a handful of connections is simplest, and lightest, with one thread each.

## Licence

MIT. See [`../LICENCE.txt`](../LICENCE.txt).
