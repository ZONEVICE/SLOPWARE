# Reptile

> **This software was generated 100% using artificial intelligence** — specifically Claude Code + Opus 5.5, Max effort — on September 24, 2026. Generated with the `new-app` skill. The initial prompt used to create this application can be found in [`prompts/init.md`](prompts/init.md). Post-creation adjustments draw on Claude Code + Opus 5.5, Max effort: the Rust implementation and the Node.js watcher rewrite were made on October 8, 2026, from the second prompt in the same file.

Reptile keeps one directory identical on two computers of the same local
network, in real time and in both directions, over HTTP or HTTPS. It is a much
simpler cousin of Syncthing: one instance **hosts** a directory, another
instance **syncs** it, and from then on every file created, modified, renamed
or deleted on either side appears on the other one within a second or so.

Everything runs in one process: the web server, the control panel it serves to
your browser, the network discovery and the synchronisation engine. Nothing
about Reptile itself is ever written to disk: the hosted directory, the PIN,
the connection and the list of instances live in memory and vanish when the
process stops. The synchronised files, of course, stay where they are.

## Two implementations, one product

| | [`node/`](node/) | [`rust/`](rust/) |
| --- | --- | --- |
| What you run | `npm start` (Node.js 20.19+) | one executable, nothing to install |
| Dependencies | none (Node.js's standard library) | `rustls`, `ring`, `serde_json`, `libc` / `windows-sys` |
| Packages | — | Debian `.deb`, Linux binary, Windows 10/11 `.exe` |
| Memory, idle | ~67 MB | ~1 MB |

Both implementations speak the same wire protocol and serve the same control
panel (the files in `node/public`, which the Rust build embeds). **They are
interchangeable and interoperable**: a Rust instance finds, hosts for and syncs
from a Node.js instance exactly as it would another Rust instance, over HTTP or
HTTPS, in both directions. Pick per machine:

- **Rust** for an always-on machine, a large tree, a small computer, or
  Windows: a 3 MB binary that uses a fraction of the memory and CPU.
- **Node.js** where Node.js is already installed and you would rather run from
  source than download a binary.

The product version is [`version.txt`](version.txt) (SemVer), shared by both.
`GET /api/ping` reports it, and so does `reptile --version`.

## Quick start

Rust (see [`rust/README.md`](rust/README.md) for packages and building):

```bash
reptile                        # HTTP, port 55667 (or the next free one)
reptile --https                # a brand-new self-signed certificate, then HTTPS
```

Node.js (see [`node/README.md`](node/README.md)):

```bash
cd node
npm start                      # HTTP, port 55667 (or the next free one)
npm start -- --https
```

Then open the control panel URL printed at startup, `http://localhost:55667`
by default, **on the same computer**. A busy port never stops Reptile from
starting: it walks up to the next free one and says so, so starting it twice
gives you two independent instances. That is also the easiest way to try it on
a single machine: host a directory in one, sync it into another directory from
the second one.

## Using it

### The status bar

Always visible at the top: the computer's host name, the IP address on the
local network, the port, the protocol (HTTP or HTTPS), and the session UUID, a
random UUIDv4 generated each time Reptile starts. On the right, while hosting
or syncing, a summary of the connection state, and the **Scanning** switch,
which turns the background search for other instances on and off.

### Hosting a directory

1. Type the absolute path of the directory. While you type, Reptile checks
   that it exists, is a directory and that its content can be read.
2. Optionally give it a name. Other instances see this name; if you leave it
   empty, the directory's own name is used.
3. A random 4-digit PIN is proposed. Change it if you like.
4. The whole tree appears with a checkbox in front of every file and
   directory. Everything is checked. **Only checked items are shared.**
   Unchecking a directory unchecks everything inside it.
5. Click **Host**.

From there you can change the PIN at any time, stop hosting, or switch to
syncing a directory, which also stops hosting. To host several directories at
once, run several Reptile processes.

Unchecked items never leave your computer and can never be changed from the
other side, not even by deleting or renaming their parent directory there. If
you rename an unchecked item on your side, it stays unchecked under its new
name.

### Syncing a directory

1. Pick the instance: every instance found on the network is listed, and the
   ones that host a directory can be chosen with one click. Instances running
   the other protocol (HTTP vs HTTPS) are listed as incompatible. If an
   instance is not listed, open **Enter its address** and type its IP and port.
2. Type the absolute path where the synced copy will live. It is created if it
   does not exist. If it already has content, that content is merged.
3. Type the PIN. A wrong PIN can be retried as often as needed.

If the host changes the PIN, you are disconnected at once and asked for the
new one; syncing resumes as soon as you type it, including whatever changed on
either side in the meantime. If the host stops hosting, you are told so.

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
- **Not synchronised:** symbolic links and special files (listed in the tree,
  never sent), and Reptile's own temporary files (`.reptile-<hex>.tmp`).

## Security

The PIN is the only protection, and it is deliberately symbolic: four digits,
no limit on attempts. Use Reptile on a network you trust.

The control panel shows the PIN and can share any directory the process can
read, so by default it only answers requests coming from the computer Reptile
runs on. Start with `--remote-ui` to open it to the network.
Instance-to-instance traffic only ever exposes what is being hosted, and only
after the PIN. Over HTTPS, every instance generates a new self-signed
certificate at startup; instances accept each other's and pin the one they saw
when a session started.

## Configuration

The same flags and variables for both implementations. Flags win over
environment variables, which win over defaults.

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
| — | `REPTILE_CERT_DIR` | see below | Where `--https` writes its certificate |

Where the certificate goes by default, and the variables only one
implementation has, are in each implementation's README. Discovery scans the
/24 of every network interface that faces the LAN (Docker bridges, VPN tunnels
and virtual machine networks are skipped) plus this computer's loopback, on
ports 55667–55686; an instance started with another `--port` also scans the 20
ports starting there.

## Performance

Measured with [`bench/bench.mjs`](bench/bench.mjs) on one Linux laptop: a host
and a peer on loopback, 20 000 small files (about 50 MB) in 200 directories,
then live changes. Each row is the time until both trees are identical; RSS is
the resident memory of each process. "Node.js 1.0" is the original
implementation, which watched the disk with chokidar.

| Scenario | Node.js 1.0 | Node.js 1.1 | Rust 1.1 |
| --- | --- | --- | --- |
| Memory, idle | 70 MB | 67 MB | **1.2 MB** |
| Memory, live with 20 000 files watched (host / peer) | 355 / 354 MB | 159 / 259 MB | **14 / 36 MB** |
| Start hosting (index 20 000 files) | 1.46 s | 0.31 s | **0.08 s** |
| Initial sync of 20 000 files | 14.6 s | 12.9 s | **2.0 s** |
| 2 000 new files, host → peer | 13.6 s | 3.4 s | **1.3 s** |
| 2 000 new files, peer → host | 17.5 s | 4.0 s | **1.3 s** |
| 500 files modified | 9.2 s | 2.0 s | **1.1 s** |
| One 256 MB file | 2.7 s | 2.0 s | **1.6 s** |
| Delete a 20 000-file tree | 29.2 s | 4.1 s | **2.4 s** |
| CPU of the receiving side, 2 000 new files | 16.3 s | 2.4 s | **0.3 s** |

Live timings include the deliberate debounce of change detection (a removal is
held about a second in case it is half of a rename), which is the same in all
three. Node.js 1.1 replaced chokidar with plain `fs.watch` (see
`node/CLAUDE.md`). Disk-bound numbers vary from run to run on a busy machine;
the ratios do not.

```bash
node bench/bench.mjs --quick                             # Node.js, a smoke run
node bench/bench.mjs --cmd rust/target/release/reptile   # Rust
node bench/bench.mjs --host-cmd "node node/src/index.js" --peer-cmd rust/target/release/reptile
```

## Repository layout

```
version.txt     the product version, shared by both implementations
node/           the Node.js implementation, and the control panel (node/public)
rust/           the Rust implementation (embeds node/public at build time)
bench/          the black-box benchmark, for either implementation or a mix
prompts/        the prompts that produced Reptile, as history
```

[`CLAUDE.md`](CLAUDE.md) is the maintenance guide, with the wire protocol both
implementations share; each implementation has its own guide next to its code.

## Tests

```bash
cd node && npm test        # 224 tests, about 15 s (includes a headless Chromium pass)
cd rust && cargo test      # 150 tests, about 15 s (includes Rust <-> Node.js interoperability)
```

## Licence

MIT. See [`LICENCE.txt`](LICENCE.txt).
