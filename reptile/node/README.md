# Reptile — Node.js implementation

> **This software was generated 100% using artificial intelligence** — specifically Claude Code + Opus 5.5, Max effort — on September 24, 2026. Generated with the `new-app` skill. The prompts are in [`../prompts/init.md`](../prompts/init.md). Post-creation adjustments draw on Claude Code + Opus 5.5, Max effort.

This is the Node.js implementation of Reptile. What Reptile does, how to use
the control panel, how synchronisation behaves and how both implementations
compare are in the product README, [`../README.md`](../README.md). This file
covers running and maintaining this implementation.

It is wire-compatible with the Rust implementation in [`../rust`](../rust): the
two find, host for and sync with each other. The control panel in `public/`
is shared: the Rust build embeds these same files.

## Requirements

- Node.js 20.19 or newer (developed and tested on Node 24).
- For `--https` only: the `openssl` command-line tool (installed by default on
  Linux Mint, Ubuntu, Debian, macOS).
- For the browser tests only: Chromium or Chrome. They skip themselves if none
  is installed.

There are no npm dependencies at all: everything is Node.js's standard
library, so there is nothing to install.

## Run

```bash
npm start                      # HTTP, port 55667 (or the next free one)
npm start -- --http            # the same, explicitly
npm start -- --https           # a brand-new self-signed certificate in cert/, then HTTPS
npm start -- --port 8080       # start at another port
npm start -- --no-scan         # start with network discovery switched off
npm start -- --help            # every option
```

`node src/index.js` works the same from any directory. Every flag and
variable is listed in the product README; this implementation also reads:

| Variable | Default | Meaning |
| --- | --- | --- |
| `REPTILE_CERT_DIR` | `node/cert` | Where `--https` writes its certificate |
| `REPTILE_OPENSSL` | `openssl` | The OpenSSL binary to run |

`--https` generates a new certificate on **every** start and replaces the
previous one in `cert/` (with several HTTPS instances started from the same
directory, `cert/` holds the newest one; each process keeps serving the
certificate it generated).

The version comes from [`../version.txt`](../version.txt), shared with the Rust
implementation.

## Tests

```bash
npm test                                  # 224 tests, about 15 seconds
node --test tests/sync.test.js            # one file
REPTILE_SKIP_BROWSER_TESTS=1 npm test     # without the Chromium pass
REPTILE_TEST_LOG=debug npm test           # with the instances' logs
```

They use `node:test` and nothing else: port selection, certificate generation,
discovery (including incompatible protocols), path validation, the content
selection, the PIN, synchronisation in both directions (create, modify,
rename, delete, files and directories, the initial merge and conflicts), the
one-connection rule, reconnection, HTTPS end to end, the HTTP surface and its
guard, the change detector, and the whole control panel in a real headless
Chromium. Interoperability with the Rust implementation is tested from the
Rust side (`cargo test --test interop` in `../rust`).

## Project layout

```
src/
  index.js      entry point and startup banner
  app.js        composition root: wires everything together
  config.js     flags, environment, defaults
  lib/          dependency-free helpers (network, certificates, HTTP client, ...)
  fs/           the filesystem side: walking, validating, watching, safe writes
  domain/       the rules: hosting, syncing, discovery, selection, planner, PIN
  peer/         the instance-to-instance client and the discovery probe
  http/         router, guard, server-sent events, route plugins
  reporters/    event-bus subscribers (console messages)
public/         the control panel: HTML, CSS and ES modules, served as-is
tests/          the test suite
```

[`CLAUDE.md`](CLAUDE.md) is this implementation's maintenance guide;
[`../CLAUDE.md`](../CLAUDE.md) has what both implementations share, the wire
protocol first.

## Licence

MIT. See [`../LICENCE.txt`](../LICENCE.txt).
