# AllySwally

> **This software was generated 100% using artificial intelligence** — specifically Claude Code + Opus 4.8, Max effort — on October 8, 2026. Generated with the `new-app` skill. The initial prompt used to create this application can be found in [`prompts/init.md`](prompts/init.md). Post-creation adjustments draw on Claude Code + Opus 4.8 (or 5.5), Max effort.

AllySwally turns a phone or tablet into a trackpad, keyboard and power-user
command surface for a Windows handheld (built for the Xbox Ally X, but agnostic
to any Windows desktop, laptop, handheld or headless box). A single Rust `.exe`
serves a web GUI over the LAN; your phone's browser opens it and drives the
host — move the pointer, type, fire keyboard shortcuts, open things, paste
clipboard snippets, run code, and check the host's battery, all without touching
the handheld.

It is one self-contained executable with **no dependencies**: the server is the
Rust standard library with hand-written HTTP/1.1, WebSocket (RFC 6455), JSON,
SHA-1 and Base64, and the Win32 API is called through hand-declared FFI (no
`windows-sys`). The entire front end — plain HTML, CSS and ES modules — is baked
into the binary.

## Requirements

- Windows 10 or 11 (developed and tested on Windows 10, build 19045).
- Nothing to install to run it: the `.exe` is self-contained (static CRT, only
  system DLLs). Run it **as administrator** for full input injection.
- For the "run code" feature, optionally Python, Node.js and/or AutoHotkey v1/v2
  on the host (autodetected; paths are configurable).
- To build it: a Rust toolchain (`rustc`/`cargo` 1.80+). Developed on 1.99,
  `stable-x86_64-pc-windows-gnu`.

## Run

Download or build `AllySwally.exe`, then run it (right-click → *Run as
administrator* is recommended):

```bash
AllySwally.exe
```

A console opens showing the app name in ANSI art, the **host addresses** to open
in a browser, and a 6-character **access PIN**. On your phone or tablet, open one
of the printed `http://<host-ip>:8787` addresses, enter the PIN, and you are in.

Options (bare words, matching the repository's other apps; dashed spellings are
also accepted):

```bash
AllySwally.exe port 9000
```

- `port <number>` — the TCP port (default **8787**). If it is busy, AllySwally
  walks upward to the next free port and prints the one it actually bound, so
  launching a second instance just gives a second server. (A second instance is
  actually prevented by a single-instance lock; the port walk covers an
  unrelated program holding the port.)

The server listens on `0.0.0.0`, so it works over home Wi-Fi, the phone's Wi-Fi
hotspot, **Bluetooth PAN**, or **USB tethering** without any change — see
[`CLAUDE.md`](CLAUDE.md) for how to connect each way.

## Build

```bash
cargo build --release
```

The optimized binary is at `target/release/AllySwally.exe` (~730 KB, single
file, no redistributables needed). The release profile uses `opt-level = "z"`,
LTO and a stripped binary; `.cargo/config.toml` links the CRT statically.

## Features

Four tabs, all optimized for a phone and scaling up to tablet and desktop:

- **Mouse** — a laptop-style trackpad (drag to move, tap/double-tap to click,
  two-finger scroll, long-press to drag), virtual left/middle/right buttons, a
  drag lock, a vertical scroll potentiometer, and options for pointer speed,
  acceleration, and absolute vs. relative movement.
- **Keyboard** — hand-built virtual keyboards in several sizes (100/80/60/40/20 %
  plus Symbols and Nav layers), a landscape toggle that rotates without turning
  the device, a command centre (Esc/Tab/F-keys/media), and a bridge to the
  phone's own native keyboard.
- **Masked** — the power-user tab: create, edit, reorder and run keyboard
  shortcuts, open/run launchers (paths, URLs, executables), clipboard snippets
  (paste or type), and code (CMD, Python, Node.js, AutoHotkey v1/v2, or Other —
  inline or a file on the host). Items can be pinned to the shortcut band above
  the Mouse and Keyboard tabs for one-tap access.
- **Settings** — appearance (6 themes, interface scale, haptics, reduced motion),
  per-device mouse and keyboard preferences, connection status with live
  latency, host info (battery, uptime, elevation, firewall) with hold-to-confirm
  power actions, data export/import/reset with automatic backups, a log viewer,
  and server actions (regenerate PIN, stop server).

**Themes:** Dark (default), Light, Dark OLED, RGB (gently animated), Kirby, and
Gorbino (deliberately ugly, Cruelty-Squad-inspired). The chosen theme is
remembered per device.

## Data and privacy

AllySwally stores data under `%USERPROFILE%\.allyswally`:

- `user-data/` — `config.json` and the MASKED items (`shortcuts.json`,
  `launchers.json`, `clipboard.json`, `scripts.json`), human-editable JSON that
  hot-reloads when changed.
- `logs/` — one JSON-Lines file per day, pruned after a configurable window
  (default 14 days).
- `backups/` — dated snapshots taken automatically before any import or reset.

The content of typed text and clipboard payloads is **never logged** (they could
be passwords) — only a type and a character count. Executed commands are logged
in full as an audit trail.

The web server is HTTP only and therefore not a browser "secure context", so the
app never relies on the Clipboard API, Wake Lock or service workers; it uses
feature detection and the APIs that do work over HTTP (Fullscreen, `vibrate`).

## Security note

This is a tool for controlling **your own** machine over **your own** network.
Running the `.exe` as administrator and using the "run code" feature means the
connecting device can run arbitrary code on the host — that is the point, and it
is the user's responsibility. The PIN gate, per-IP lockout after three wrong
tries, and per-session tokens guard access; the PIN is shown only on the host
console. Without elevation, Windows blocks input to higher-integrity windows
(Task Manager, apps run as admin) and the UAC secure desktop is never reachable.

## Tests

```bash
cargo test
```

83 unit tests cover the hand-rolled primitives (SHA-1 and the WebSocket RFC 6455
handshake vector, Base64, JSON parser/serializer with line/column errors, the
HTTP parser, the port walk), the PIN/lockout/session logic, the persistence
store (including tolerance to hand-edited invalid JSON), the MASKED item model,
config parsing, the event hub, input key mapping, command execution, and the
export/import bundle.

## Licence

MIT. See [`LICENCE.txt`](LICENCE.txt).
