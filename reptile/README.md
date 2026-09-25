# Reptile

> **This software was generated 100% using artificial intelligence** — specifically Claude Code + Opus 5.5, Max effort — on September 24, 2026. Generated with the new-app skill. The initial prompt used to create this application can be found in [`prompts/init.md`](prompts/init.md). Post-creation adjustments draw on Claude Code + Opus 5.5, Max effort.

Reptile keeps one directory identical on two computers of the same local
network, in real time and in both directions, over HTTP or HTTPS. It is a much
simpler cousin of Syncthing: one instance **hosts** a directory, another
instance **syncs** it, and from then on every file created, modified, renamed
or deleted on either side appears on the other one within a second or so.

Everything runs in one Node.js process: the web server, the control panel it
serves to your browser, the network discovery and the synchronisation engine.
The only npm dependency is [`chokidar`](https://github.com/paulmillr/chokidar),
which watches the disk. Nothing about Reptile itself is ever written to disk:
the hosted directory, the PIN, the connection and the list of instances live in
memory and vanish when the process stops. The synchronised files, of course,
stay where they are.

## Requirements

- Node.js 20.19 or newer (developed and tested on Node 24).
- For `--https` only: the `openssl` command-line tool (installed by default on
  Linux Mint, Ubuntu, Debian, macOS).
- For the browser tests only: Chromium or Chrome. They skip themselves if none
  is installed.

## Install and run

```bash
npm install
npm start                      # HTTP, port 55667 (or the next free one)
```

Other ways to start it:

```bash
npm start -- --http            # the same, explicitly
npm start -- --https           # a brand-new self-signed certificate in cert/, then HTTPS
npm start -- --port 8080       # start at another port
npm start -- --https --port 9443
npm start -- --no-scan         # start with network discovery switched off
npm start -- --help            # every option
```

Then open the control panel URL printed at startup, `http://localhost:55667`
by default, **on the same computer**.

A busy port never stops Reptile from starting: if 55667 is taken it uses 55668,
then 55669, and so on, and says so. Running `npm start` twice gives you two
independent instances, which is also the easiest way to try Reptile on a
single machine: host a directory in one, sync it into another directory from
the second one.

`--https` generates a new certificate on **every** start and replaces the
previous one in `cert/` (with several HTTPS instances started from the same
directory, `cert/` holds the newest one; each process keeps serving the
certificate it generated). The certificate is self-signed, so your browser
shows its usual warning the first time; accept it. Reptile instances accept each
other's self-signed certificates automatically, and pin the certificate they
saw when a session started for the rest of that session.

## Using it

### The status bar

Always visible at the top: the computer's host name, the IP address on the
local network, the port, the protocol (HTTP or HTTPS), and the session UUID,
a random UUIDv4 generated each time Reptile starts. On the right, while
hosting or syncing, a summary of the connection state (click it to go back to
the start screen), and the **Scanning** switch, which turns the background
search for other instances on and off.

### Hosting a directory

1. Type the absolute path of the directory. While you type, Reptile checks
   that it exists, is a directory and that its content can be read, and says
   so under the field.
2. Optionally give it a name. Other instances see this name; if you leave it
   empty, the directory's own name is used.
3. A random 4-digit PIN is proposed. Change it if you like.
4. As soon as the path checks out, the whole tree appears with a checkbox in
   front of every file and directory. Everything is checked. **Only checked
   items are shared.** Unchecking a directory unchecks everything inside it.
5. Click **Host**. You are back on the start screen, which now shows the
   hosted directory, its PIN, the connection state and the activity.

From there you can change the PIN at any time, stop hosting (to host another
directory), or switch to syncing a directory, which also stops hosting. To host
several directories at once, run several Reptile processes.

Unchecked items never leave your computer and can never be changed from the
other side, not even by deleting or renaming their parent directory there. If
you rename an unchecked item on your side, it stays unchecked under its new
name.

### Syncing a directory

1. Pick the instance: every instance found on the network is listed, and the
   ones that host a directory can be chosen with one click. Instances running
   the other protocol (HTTP vs HTTPS) are listed as incompatible. If an
   instance is not listed (another subnet, scanning switched off), open
   **Enter its address** and type its IP and port; Reptile checks that a
   Reptile instance hosting a directory answers there.
2. Type the absolute path where the synced copy will live. It is created if it
   does not exist. If it already has content, that content is merged with the
   host's.
3. Type the PIN. A wrong PIN can be retried as often as needed.

The first synchronisation compares both sides completely: what only one side
has is copied to the other, and where both have a different version of a file,
the newer one wins. From then on, changes flow as they happen.

If the host changes the PIN, you are disconnected at once and asked for the new
one; syncing resumes as soon as you type it, including whatever changed on
either side in the meantime. If the host stops hosting, you are told so. Both
control panels always show the connection state.

## How synchronisation behaves

- **Renames are renames.** Renaming or moving a file or a directory renames it
  on the other side instead of deleting and transferring it again.
- **Conflicts.** If both sides change the same file before the other side saw
  the change, the newer version wins everywhere. A modification always beats a
  deletion. A file on one side with a directory of the same name on the other
  is left alone and reported.
- **After an interruption** (network drop, PIN change) the two copies are
  compared again, and deletions made during the interruption are understood as
  deletions, as long as the syncing process kept running.
- **Safety.** If the local synced directory (or the hosted one) disappears, for
  example because a drive was unplugged, syncing stops instead of deleting
  everything on the other side.
- **Not synchronised:** symbolic links and special files (they are listed in
  the tree, but never cross the network), and Reptile's own temporary files
  (`.reptile-<hex>.tmp`, used while a file is being received).

## Security

The PIN is the only protection, and it is deliberately symbolic: four digits,
no limit on attempts. Use Reptile on a network you trust.

The control panel shows the PIN and can share any directory the process can
read, so by default it only answers requests coming from the computer Reptile
runs on. Start with `--remote-ui` to open it to the network. Instance-to-instance
traffic is unaffected by this: it only ever exposes what is being hosted, and
only after the PIN.

## Configuration

Command-line flags win over environment variables, which win over defaults.

| Flag | Variable | Default | Meaning |
| --- | --- | --- | --- |
| `--http` / `--https` | `REPTILE_PROTOCOL` | `http` | Protocol |
| `--port` | `REPTILE_PORT` | `55667` | First port to try |
| `--host` | `REPTILE_HOST` | `0.0.0.0` | Interface to bind |
| — | `REPTILE_PORT_ATTEMPTS` | `64` | Ports to walk past when busy; `1` disables it |
| `--no-scan` | `REPTILE_SCAN=0` | on | Start with discovery switched off |
| `--scan-hosts` | `REPTILE_SCAN_HOSTS` | local /24s | Hosts to scan, e.g. `192.168.1.0/24,10.0.0.7` |
| `--scan-ports` | `REPTILE_SCAN_PORTS` | `55667-55686` | Ports to scan on each host |
| `--remote-ui` | `REPTILE_REMOTE_UI=1` | off | Allow other computers to open the control panel |
| `--log-level` | `REPTILE_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, `debug` |
| — | `REPTILE_CERT_DIR` | `./cert` | Where `--https` writes its certificate |
| — | `REPTILE_OPENSSL` | `openssl` | The OpenSSL binary to run |

Discovery scans the /24 of every network interface that faces the LAN (Docker
bridges, VPN tunnels and virtual machine networks are skipped) plus this
computer's loopback, on ports 55667–55686. An instance started with another
`--port` also scans the 20 ports starting there. A full sweep of a /24 takes
about two seconds and repeats every eight; instances already found are
re-checked every three seconds.

## Tests

```bash
npm test
```

219 tests with `node:test`, no extra dependency: port selection, certificate
generation, the ping endpoint and discovery (including incompatible
protocols), path validation, the content selection, the PIN (right, wrong,
changed while connected), synchronisation in both directions (create, modify,
rename, delete, for files and directories, plus the initial merge and
conflicts), the one-connection rule, protocol mismatches, reconnection, HTTPS
end to end, the HTTP surface and its guard, and a full pass through the
control panel in a real headless Chromium. They take about 16 seconds.

```bash
node --test tests/sync.test.js           # one file
REPTILE_SKIP_BROWSER_TESTS=1 npm test    # without the browser pass
REPTILE_TEST_LOG=debug npm test          # with the instances' logs
```

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

[`CLAUDE.md`](CLAUDE.md) is the maintenance guide, with the architecture and
the protocol in detail.

## Licence

MIT. See [`LICENCE.txt`](LICENCE.txt).
