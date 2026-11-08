# Tendril

> **This software was generated 100% using artificial intelligence** — specifically Claude Code + Opus 5.5, Max effort — on October 14, 2026. Generated with the `new-app` skill. The initial prompt used to create this application, and a later one, can be found in [`prompts/init.md`](prompts/init.md). Post-creation adjustments draw on Claude Code + Opus 5.5, Max effort, on Linux Mint, and on Claude Code + Opus 4.8, Max effort, on Windows 10.

Tendril is a lightweight code editor that you use from a web browser. One
self-contained binary — `tendril` on Linux, `tendril.exe` on Windows — serves
the whole editor over HTTPS: start it on a machine, open the address it
prints from any device of your network, your VPN or the Internet, type the
password, pick a folder and edit.

It feels like a small VS Code: a file tree, tabs, a split editor, a menu bar
and an icon toolbar, a command palette, find in files, an integrated
terminal, git source control, a Markdown preview, viewers for images, video,
audio and PDF, nine themes, and a choice of two editor engines —
**CodeMirror 6** (default, light, touch-friendly) and **Monaco** (the VS Code
engine, with IntelliSense for JavaScript, TypeScript, JSON, CSS and HTML). It
works on phones too.

It is built to cost almost nothing on the machine that runs it: about
**2.6 MB of RAM idle** and around 5.5 MB while serving a full session, one
thread, in a static binary of about 7 MB that embeds the entire front end.
A Raspberry Pi or a 1 GB VM is plenty.

## Features

- **Editing**: syntax highlighting for 50+ languages, multiple cursors, find
  and replace, go to line, comment toggling, line moves, folding,
  autocompletion, word wrap, minimap, indentation detection, auto save,
  trim-on-save. Line endings (LF/CRLF) and the UTF-8 BOM of each file are
  preserved. Switching between CodeMirror and Monaco keeps unsaved changes.
- **Files**: a lazy file tree with multi-selection, inline new file/folder
  and rename, copy/cut/paste, duplicate, delete, drag and drop to move (hold
  Ctrl or Alt to copy), drag files from your desktop to upload them, download.
  Saving detects files changed on disk by another program and asks before
  overwriting; clean files simply reload.
- **Go anywhere**: Go to File (`Ctrl+P`) with fuzzy matching, the command
  palette (`Ctrl+Shift+P` / `F1`), Find in Files (`Ctrl+Shift+F`).
- **Split editor**: two editor groups side by side (`Ctrl+\`, or drag a tab
  to the right half of the editor), each with its own tabs; the same file
  can be open in both and edits show in both at once. Not on phones.
- **Markdown preview**: beside the editor (`Ctrl+Shift+V`), updated as you
  type: tables, task lists, code blocks in the editor's colors, images from
  the folder or the web. Links to other files open them.
- **Git**: with the `git` installed on the host (Tendril does not include
  one). A Source Control view (`Ctrl+Shift+G`) to stage, unstage, discard
  and commit, side-by-side diffs, colors and letters in the file tree, the
  branch in the status bar, switching and creating branches, fetch, pull and
  push. See [Git](#git).
- **Viewers**: images (zoom, transparency checkerboard), video and audio
  (seekable: the server answers range requests), PDF (the browser's viewer).
- **Terminal**: real shells in pseudo-terminals (bash/your `$SHELL` on Linux,
  PowerShell or `cmd.exe` on Windows), in a bottom panel, several at once.
- **Themes**: Dark, Light, Kirby, Gorbino (inspired by *Cruelty Squad*),
  Dark OLED, Dos, Nuclear, Ambar and Eye Burned. The first visit follows your
  system's light/dark preference; your choice is remembered by the browser.
- **Phones**: the sidebar becomes a drawer, buttons grow to finger size and a
  row of extra keys (Tab, arrows, brackets…) sits above the on-screen keyboard.
- **Safety**: password login, three wrong passwords block the address until
  restart, HTTPS by default, strict confinement of every file operation to
  the chosen folder, and an automatic shutdown after three hours without
  activity (configurable, cannot be turned off).

## Running it

No installation and no other files: run the binary.

```bash
./tendril
```

```text
Tendril 1.0.0 - lightweight web code editor

  Mode       HTTPS, self-signed certificate (new on every start: the browser will warn)
  SHA-256    72:4E:63:0F:...
  Listening  0.0.0.0:6060
  Open       https://localhost:6060
             https://192.168.1.20:6060
  Password   Xk3m9Qa2
             generated for this run and shown only once; set your own with
             --password <text> or "password" in settings.json
  Idle       closes itself after 180 minute(s) without activity
  Data       /home/you/.tendril
```

Open one of the addresses, accept the certificate warning (compare the
SHA-256 with the one printed if you want to be sure), enter the password and
choose the folder to work in. Tendril writes nothing into that folder except
the files you edit.

On Windows, double-click `tendril.exe` or run it from a terminal; the console
window shows the same banner. Closing that window stops Tendril. When it is
double-clicked and cannot start (for example a `settings.json` with a syntax
error), it prints the reason and waits for Enter, so the message can be read
before the window closes.

The first start on Windows also shows the system's "allow access" prompt of
Windows Defender Firewall. Its answer is saved as rules for that `.exe` path,
usually allowing private networks and blocking public ones, and a block rule
wins over any allow rule. If the editor opens on the host itself but not from
other devices, replace those rules from an administrator PowerShell (with
your path; `-Profile Any` also allows networks classified as Public):

```powershell
$exe = "C:\Tools\tendril.exe"
Get-NetFirewallApplicationFilter -Program $exe | Get-NetFirewallRule | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "Tendril" -Direction Inbound -Program $exe -Action Allow -Profile Any
```

### Command line

```text
tendril [https|http] [--password <text>] [--port <n>] [--bind <ip>]
tendril --help | --version
```

| Option | Default | Meaning |
| --- | --- | --- |
| `https` / `http` | `https` | `http` serves plain, unencrypted HTTP: use it only on a trusted network |
| `--password <text>` | settings.json, else random | The login password; overrides settings.json |
| `--port <n>` | 6060 | Port to listen on. A busy port is not an error: the next free one is used and printed. `0` picks any free port |
| `--bind <ip>` | `0.0.0.0` | Address to listen on; `127.0.0.1` keeps Tendril local to the machine |

The password comes from `--password`, then from `"password"` in
`settings.json`, and otherwise is a random 8-character password printed once.

### Where Tendril keeps its data

Everything lives in `.tendril` in the home folder of the user who runs it
(`~/.tendril` on Linux, `C:\Users\<you>\.tendril` on Windows):

```text
.tendril/
  settings.json        your settings (created with the defaults on first run)
  recent.json          recently opened folders
  cert/cert.pem        the self-signed certificate, replaced on every start
  cert/key.pem         its private key (owner-only on Linux)
  logs/YYYY-MM-DD.jsonl   JSON Lines logs, one file per UTC day
```

### Settings

Edit them in the Settings tab (`Ctrl+,`) or directly in `settings.json`. Every
field is optional; missing fields take their default. The most important ones:

| Key | Default | |
| --- | --- | --- |
| `password` | none | Login password (plain text: protect the file) |
| `idle_timeout_minutes` | `180` | Stop after this many minutes without activity; minimum 1, cannot be disabled (a huge value effectively does, at your own risk) |
| `port`, `bind` | `6060`, `"0.0.0.0"` | Applied at the next start |
| `default_editor` | `"codemirror"` | Or `"monaco"` |
| `allowed_hosts` | `[]` | Host names the server answers to (empty: any). Recommended in HTTP mode |
| `max_editor_file_mb` | `5` | Larger files offer a download instead of opening |
| `max_upload_mb` | `1024` | Largest upload |
| `max_terminals` | `4` | Terminals open at once, for the whole server |
| `terminal_shell` | `""` | The shell of the integrated terminal; see [Terminal shell](#terminal-shell) |
| `log_retention_days`, `log_max_total_mb` | `30`, `50` | Old logs are deleted; the folder never grows past the cap |
| `search_exclude` | `.git`, `node_modules`, `target`… | Folders skipped by Find in Files and Go to File |
| `editor.*`, `ui.*` | | Font, tabs, wrap, minimap, auto save, sidebar side, hidden files… |

Settings that can change while running (idle timeout, logs, editor and
interface preferences, the password unless `--password` was given) apply at
once.

### Terminal shell

`terminal_shell` (Settings → Terminal → Shell, or `settings.json`) is the
command each new terminal starts: a program followed by its arguments.

- **Empty (the default)** picks the platform's shell. On Windows that is
  Windows PowerShell (`powershell.exe`), or `cmd.exe` when PowerShell is not
  installed; on Linux, your `$SHELL`, then `/bin/bash`, then `/bin/sh`.
- **A program name** is looked up in `PATH`, like in a terminal. Arguments go
  after it, separated by spaces.
- **A path with spaces** must be in double quotes, with the arguments after the
  closing quote. A bare path to an existing file also works without quotes when
  it has no arguments.
- **A shell that cannot be started** (misspelled, not installed) is not an
  error: the terminal opens with the default shell and says why, in yellow.

| Value | Starts |
| --- | --- |
| *(empty)* | The platform default |
| `cmd.exe` | Command Prompt |
| `powershell.exe -NoLogo` | Windows PowerShell 5.1, without its copyright banner |
| `pwsh -NoLogo` | PowerShell 7, when it is in `PATH` |
| `"C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo` | PowerShell 7 by full path |
| `wsl.exe` | The default WSL distribution |
| `"C:\Program Files\Git\bin\bash.exe" --login -i` | Git Bash |
| `bash -l` | bash as a login shell (Linux) |
| `zsh`, `fish`, `/bin/sh` | Other Unix shells |

### Git

Git works when the host has `git` installed and the chosen folder is inside a
repository; otherwise the Source Control view says so and the rest stays out
of the way. Tendril runs the host's `git` in the folder, so its configuration
(user name and e-mail, hooks, credentials) applies as in a terminal.

- **What it does**: shows the branch and how far it is ahead of or behind its
  upstream, the changed files (staged, unstaged, untracked, conflicts),
  side-by-side diffs (a unified view on phones), stages and unstages files,
  discards changes (deleting untracked files; always with confirmation),
  commits (offering to stage everything when nothing is staged), switches to
  local or remote branches, creates branches, fetches, pulls and pushes (a
  branch without upstream is published to `origin`).
- **What it does not do**: anything that rewrites history or deletes
  branches — no force push, reset, rebase, amend or branch deletion. Pull only
  fast-forwards; when a merge is needed, git's message says so: use the
  terminal for that.
- **Credentials** must already work without typing anything: an SSH agent or
  key without passphrase, or a credential helper that remembers them. Tendril
  never lets git ask for a password (it could not answer, and a prompt on the
  host would block it); when git needs one, the operation fails with git's
  message and the terminal is the place to log in once.
- Paths are checked like every other file operation and passed literally to
  git (`*` is a file name, not a pattern). Remote operations stop after three
  minutes.

### What counts as activity

The idle timer is reset only by a person: requests the browser makes because
you did something, keystrokes typed into a terminal, and, while you type in
the editor without saving, a ping at most once a minute. Background polling
and programs printing in a terminal do not count, so a forgotten browser tab
cannot keep Tendril alive. Five minutes before the end the browser warns you;
the status bar always shows the time left.

### Security model

- Nothing but the login page answers before the password; sessions live in
  memory (restarting Tendril logs everyone out) in an `HttpOnly`,
  `SameSite=Strict` cookie (`Secure`, `__Host-` prefixed, over HTTPS).
- Three wrong passwords from one IP address block it — every request gets
  403 — until Tendril restarts. Everyone behind the same public address or
  VPN exit shares that counter.
- Requests that change anything, and the terminal's WebSocket, must come
  from Tendril's own page (`Origin` check), so other sites cannot act through
  your browser.
- Every path is checked to stay inside the chosen folder, symbolic links
  included. Files of the folder are never served as active pages: HTML is
  downloaded, SVG is sandboxed.
- A strict Content-Security-Policy forbids inline and foreign scripts. Images
  may come from other servers (`https`, and `http` when Tendril runs on HTTP)
  so the Markdown preview can show them; no referrer is sent with them. The
  HTML inside Markdown is filtered to a safe subset before it is shown.
- The logs record logins, blocks, opened folders, file operations (path and
  type, never contents), terminals and settings changes — never passwords or
  session tokens.

## Building

Requirements: [Rust](https://rustup.rs) (stable) and Node.js 18+ with npm
(only to bundle the front end; the binary never needs Node).

```bash
./build.sh            # native release binary: target/release/tendril
./build.sh dist       # static binaries for Linux x86_64 / aarch64 and Windows: dist/
```

`dist` cross-compiles with [zig](https://ziglang.org) and
[cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild) and needs the
rustup targets listed at the top of `build.sh`; the Linux binaries are static
(musl) and the aarch64 one runs on a Raspberry Pi 3/4/5.

On Windows (MSVC toolchain, Visual Studio Build Tools):

```powershell
.\build.ps1           # dist\tendril-<version>-windows-x86_64.exe
.\build.ps1 -Test     # also runs the test suites
```

`build.ps1` builds with an installed MSVC toolchain even when rustup's default
is the GNU one, and prints which toolchain it picked; set `RUSTUP_TOOLCHAIN` to
force another. Without MSVC it falls back to GNU, which needs MinGW-w64 on
`PATH` for some crates. If PowerShell refuses to run scripts, use
`powershell -ExecutionPolicy Bypass -File .\build.ps1`. The `.exe` from
`build.ps1` (MSVC) and the one from `./build.sh dist` (GNU, cross-built on
Linux) are the same program; both run as a single file.

By hand: `npm --prefix web ci`, `node web/build.mjs`, then `cargo build --release`.
`web/dist` is a build output: after pulling or syncing front-end changes,
build it again (cargo warns when it is older than `web/src`).

## Testing

```bash
cargo test                                  # Linux 136, Windows 128: unit + integration against a real server
npm --prefix web test                       # front-end unit tests
cargo build && node --test tests/browser/*.test.mjs   # end to end in headless Chromium or Edge
```

The integration tests start real servers on free ports with temporary data
folders (HTTP and HTTPS, the terminal WebSocket, traversal attempts, the
blacklist, the idle shutdown, git against the host's real `git`). The
end-to-end test drives the whole UI in Chromium: login, folder picker,
creating, editing, saving, renaming and deleting files, conflicts with the
disk, switching editors with unsaved changes, the split editor, the Markdown
preview (including hostile HTML), git staging, committing and diffs, the
terminal, settings, the menus and logout. One more step, the page shown
when the server stops for inactivity, takes over a minute and runs only with
`TENDRIL_E2E_SLOW=1`.

`tests/browser/shoot.mjs` captures every screen in every theme at desktop and
phone sizes for visual review, and `tests/wine/run.sh` runs the Windows build
under Wine 7 or newer (see `CLAUDE.md` for what Wine can and cannot test).

## Licence

MIT — see [`LICENCE.txt`](LICENCE.txt). CodeMirror, Monaco Editor and xterm.js
are MIT licensed and bundled into the binary.
