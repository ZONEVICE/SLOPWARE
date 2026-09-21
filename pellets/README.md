# Pellets

> **This software was generated 100% using artificial intelligence** — specifically Claude Code + Opus 5, Max effort — on September 21, 2026. No skills were used during generation. The initial prompt used to create this application can be found in [`prompts/init.md`](prompts/init.md). Post-creation adjustments draw on also Claude Code + Opus 5, Max effort.

A real-time chat server that keeps nothing. Rooms, messages, users and sessions
live in the memory of a single Node.js process and disappear the moment it
stops. There is no database, no JSON on disk, no build step and no account to
create: open the page, pick a username, and you are chatting.

The whole application — the HTTP server, the client it serves, and the
WebSocket layer — runs in one process, with exactly one npm dependency
([`ws`](https://github.com/websockets/ws)).

## Requirements

- Node.js 18.17 or newer (developed and tested on Node 24).
- Nothing else. No global tools, no build pipeline, no CDN.

## Install and run

```bash
npm install
npm start                    # HTTP on http://localhost:8080
```

Other ways to start it:

```bash
npm start -- --http                 # same as above, explicitly
npm start -- --https                # mints a new self-signed certificate, then HTTPS
npm start -- --port 3000            # a different port
npm start -- --http --port 3000     # a different port and HTTP
npm start -- --https --port 3000    # a different port and HTTPS
npm start -- --host 127.0.0.1       # bind only the loopback interface
npm start -- --help                 # every option
```

A busy port never stops the server from starting. If 8080 is taken it uses
8081, then 8082, and so on until it finds a free one, printing a line that says
which one it settled on. The same applies to an explicit `--port`, so running
`npm start` twice simply gives you two servers. Set `PELLETS_PORT_ATTEMPTS=1` if
you would rather it fail than move.

`--https` generates a brand new self-signed certificate on **every** run, writes
it to `cert/`, installs it on itself and serves over TLS. WebSocket connections
follow automatically: `ws://` over HTTP, `wss://` over HTTPS, with no client
configuration. Browsers will show the usual warning for a self-signed
certificate; accept it and everything works.

The startup banner prints a LAN address as well as `localhost`, and the
certificate covers the machine's own addresses, so a phone on the same Wi-Fi can
join by opening the printed URL.

## Using it

**Home** lists every open room with the number of people currently in it, and
lets anyone create more. There is no limit, and a room with nobody in it stays
open and stays listed until its creator deletes it.

**A room** is the chat itself. Someone joining a room that already has messages
sees all of them. Messages cannot be edited or deleted once sent. Drag files in,
paste a screenshot, or use the paperclip:

- an image shows as a preview; click it to see it full size
- a video shows a preview with a play badge; click it to play it with the
  browser's own controls
- anything else shows its name and extension; clicking downloads it

**Settings** lets you change your username, pick another colour and switch
between dark and light mode. Your UUID is shown but cannot be changed.

Choosing a username is the only step anyone ever has to complete. There are no
rules about what it can be, and a colour is picked for you the first time you
set one.

## What is kept, and what is not

| Data | Where it lives | Survives a restart |
| --- | --- | --- |
| Sessions, usernames, colours | Process memory | No |
| Rooms and their messages | Process memory | No |
| Who is connected | Process memory | No |
| Uploaded files | `uploads/` on disk | **Yes** |
| TLS certificate | `cert/` on disk | Replaced on every `--https` run |

Uploaded files outlive a restart on purpose, but nothing lists them afterwards:
the chat that referenced them is gone, so they are simply bytes the server can
still serve to anyone who kept the link.

## Configuration

Command line flags win over environment variables, which win over defaults.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | First TCP port to try |
| `PELLETS_PORT_ATTEMPTS` | `64` | Ports to walk past when busy; `1` disables it |
| `HOST` | `0.0.0.0` | Bind address |
| `PELLETS_PROTOCOL` | `http` | `http` or `https` |
| `PELLETS_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, `debug` |
| `PELLETS_MAX_UPLOAD_MB` | `256` | Largest attachment |
| `PELLETS_MAX_MESSAGES_PER_ROOM` | `0` | `0` means unlimited history |
| `PELLETS_MAX_MESSAGE_LENGTH` | `4000` | Characters per message |
| `PELLETS_MAX_NAME_LENGTH` | `120` | Safety bound, not a content rule |
| `PELLETS_TYPING_TIMEOUT_MS` | `6000` | When a stale typing flag expires |
| `PELLETS_SESSION_DAYS` | `30` | Session cookie lifetime |
| `PELLETS_FINGERPRINT` | `1` | `0` disables client-metadata recognition |
| `PELLETS_TRUST_PROXY` | `0` | `1` reads `X-Forwarded-For` |
| `PELLETS_UPLOADS_DIR` | `./uploads` | Where attachments are written |
| `PELLETS_CERT_DIR` | `./cert` | Where the certificate is written |
| `PELLETS_TLS_KEY_TYPE` | `ec` | `ec` (fast) or `rsa` (most compatible) |
| `PELLETS_TLS_DAYS` | `365` | Certificate validity |
| `PELLETS_TLS_ALT_NAMES` | — | Extra hostnames, comma separated |

## Tests

```bash
npm test
```

194 tests covering the DER/X.509 certificate builder, the multipart parser, the
in-memory stores, every domain rule, port selection at startup, the REST API,
uploads, the WebSocket protocol, HTTPS, and a full end-to-end pass in a real
headless Chromium. The browser tests skip themselves automatically when no
Chromium or Chrome is installed.

## Project layout

```
src/
  index.js        entry point and CLI
  app.js          composition root: wires everything together
  config.js       flags, environment, defaults
  lib/            dependency-free helpers (ids, colours, DER/X.509, mime, ...)
  store/          in-memory stores
  domain/         business rules, transport-agnostic
  http/           router, static files, multipart, REST routes
  realtime/       the ws gateway, frame handlers and broadcasters
public/           the client: HTML, CSS and ES modules, served as-is
tests/            the test suite
```

`CLAUDE.md` is the maintenance guide, with the architecture in detail.

## Licence

MIT. See `LICENCE.txt`.
