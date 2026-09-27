# Lurker — maintenance guide

This file applies to the whole `lurker/` directory and is the entry point for
an assistant arriving with no conversation context: Claude Code, Codex, or any
other coding assistant. `AGENTS.md` only points here. Read `README.md` first for
what Lurker does and how to start it.

`prompts/init.md` keeps the original prompt that produced this application.
Treat it as history, not as a specification to re-execute. `LICENCE.txt` is an
MIT licence; do not add per-file licence headers or change its terms.

---

## 1. Hard constraints

These are not preferences. Breaking one breaks the product.

- **Talk to the user in Spanish. Write code, comments, documentation and
  interface text in English.** (Repository-wide convention.)
- **Python standard library only.** No pip package, in any layer, tests
  included. That is why the X.509 certificate is encoded by hand
  (`server/lib/asn1.py`, `rsa.py`, `x509.py`), why the media readers parse
  containers themselves, and why the browser tests drive Chromium over a pipe
  (`tests/support/browser.py`) instead of Selenium or Playwright. Do not
  "simplify" any of them with a package. Python 3.8 syntax and APIs: the suite
  runs on 3.10 and 3.11, and `ast.parse(..., feature_version=(3, 8))` passes.
- **The front end is plain HTML, CSS and ES modules** served as they are from
  `public/`. No framework, bundler, transpiler, CDN, web font or build step.
- **Nothing is persisted.** No database, no JSON state, no cache on disk, and
  nothing in the browser either (no localStorage, sessionStorage or IndexedDB;
  the only cookie is the password session, a session cookie). View settings
  live in the URL hash. The only file Lurker writes is `cert/`.
- **HTTPS by default, and a NEW certificate on every HTTPS start**, replacing
  `cert/cert.pem` and `cert/key.pem` in the application directory. Required.
- **Port 8080 by default; a busy port is not an error.** Walk upwards on
  `EADDRINUSE` only, 64 ports at most, port 0 untouched
  (`server/lib/listen.py`), and report the port actually bound.
- **Options are bare words** (`https`, `port 9000`, `dir /x`, `pass s`), as the
  prompt wrote them; dashed spellings are accepted too (`server/config.py`).
- **`dir` skips the directory prompt only when the directory is usable**;
  otherwise the prompt appears with a notice saying why.
- **With `pass`, nothing but `/login` and the icon is served before
  unlocking**: not the app's scripts, not the API, not media. Sessions are tied
  to the client IP and User-Agent ("each IP/OS must enter it").
- **One album per process, shared by every browser.** Opening or closing it
  reaches every connected browser. A second album means a second Lurker.
- **The default view is the whole album in one grid** (`views/grid.js`, first
  in `VIEWS`).
- **Lurker never writes into the album**, and a client can only fetch files the
  scan registered, by album ID + item ID. Never add an endpoint that takes a
  file path for anything but `paths/check` and `paths/suggest`.
- **The eye icon is `public/icon.svg`**; the start screen draws the same eye
  inline (`components/start.js`) so its pupil can move. Keep them in step.

---

## 2. Architecture

Dependencies flow one way and never back up:

```
config ─▶ lib ─▶ media ─▶ domain ─▶ web ─▶ app.py ─▶ main.py / lurker.py
                              │
                              └─ events (lib/events.py) ─▶ SSE hub, console reporter
```

| Layer | Directory | Knows about |
| --- | --- | --- |
| Options | `server/config.py` | Nothing. Parses argv into a `Config`. |
| Helpers | `server/lib/` | The standard library only: event bus, port walk, network names, birth times (statx through ctypes), ASN.1/RSA/X.509, certificate files. |
| Media | `server/media/` | `lib`. The format table and the header readers. No album, no HTTP. |
| Domain | `server/domain/` | `lib`, `media`. **All rules**: path checks, the catalog and its revisions, scanning, probing, the album state machine, previews, passwords. |
| Web | `server/web/` | `domain`. Server, TLS, router, guard, static files, file streaming, SSE, login page, `routes/`. Holds no rules. |
| Wiring | `server/app.py` | Everything: builds the services, binds, opens `dir`. |
| Client | `public/js/` | The HTTP API and the event stream. |

The domain never imports the web layer. Services raise `AppError(status, code,
message)` (`server/domain/errors.py`); the dispatcher turns it into
`{"error": {"code", "message"}}` with that status.

### The seams (where to add things)

Each is one new file plus one line, and removing a feature is deleting the line.

1. **An HTTP endpoint** — a module in `server/web/routes/` exposing
   `register(router, services)`, listed in `ROUTE_PLUGINS`
   (`routes/__init__.py`). Routes are guarded unless registered with
   `public=True`; the static catch-all is `fallback=True` and stays last.
2. **Something that reacts to album events** — subscribe to a name in
   `server/lib/events.py` (`ALBUM_CHANGED`, `ALBUM_OPENED`, `ALBUM_CLOSED`,
   `SCAN_FINISHED`, `PROBE_FINISHED`, `SESSION_ENDED`). The SSE hub and the
   console reporter (`LurkerApp._subscribe_reporter`) are the examples. Never
   publish a string literal.
3. **A file type** — one `Format(...)` line in `server/media/formats.py`
   (extensions, kind, MIME, browser support, reader). **Its metadata** — a
   reader module in `server/media/readers/` and one line in `READERS`
   (`readers/__init__.py`). The reader contract is documented there.
4. **A view** — a module in `public/js/views/` exporting
   `{ id, label, icon, tiles, create(ctx) }`, listed in `VIEWS`
   (`views/index.js`). `create` returns `{ el, update, sequence, reveal,
   resetScroll, destroy }`; `sequence()` must return the items in display
   order, because the viewer steps through it.
5. **A filter or a sort** — `public/js/core/query.js` (`DEFAULT_FILTERS`,
   `filterItems`, the URL mapping, `SORTS`/`sortItems`), plus its control in
   `components/filters.js` and its chip in `app.js#renderChips`.

---

## 3. How the important parts work

### 3.1 Startup (`server/app.py`, `server/main.py`)

`LurkerApp.start()`: for HTTPS, mint the certificate (names from
`lib/netinfo.certificate_names`: localhost, the host name, `.local`, every
IPv4 address) and build an `SSLContext` (TLS 1.2+); bind with the port walk;
name the session cookie `lurker_<port>` (cookies ignore ports, so two
instances on one machine would otherwise log each other out); then open `dir`
through `AlbumService.open_initial`, which stores a notice when it cannot.
`main.py` prints the banner (LAN addresses exclude Docker/VM bridges; the
certificate SANs include them) and turns SIGTERM into a clean stop.

### 3.2 The album (`server/domain/album.py`)

States `empty → scanning → ready`, `ready → scanning` on rescan, and back to
`empty` on close. `open()` validates the path (`domain/paths.py`: absolute
after `~`, exists, is a directory, and its listing can really be read), creates
an `AlbumSession` (random 12-hex ID, a `Catalog`, a `Prober`, a cancel event),
**publishes `ALBUM_OPENED` first** and only then starts two threads: the
scanner and the committer. A second `open()` while one is open is `409
album_open`. `close()` cancels the session; its threads notice and stop.

The committer turns pending catalog changes into a new revision every
`commit_interval` (0.25 s) and publishes `ALBUM_CHANGED` when the revision,
state, directory count or probe progress changed. That throttling is what keeps
a 100 000-file scan from flooding the event stream.

### 3.3 Scanning (`server/domain/scanner.py`)

Iterative walk with `os.scandir`, name order (stable IDs), no symbolic links
(`is_dir(follow_symlinks=False)`), unreadable directories counted in
`ScanStats.skipped`/`errors`. `/proc`, `/sys`, `/dev`, `/run` are skipped when
the album is `/`. Folders are registered **lazily**: a directory enters the
catalog only once it or a descendant holds media. The same walk serves rescans:
`Catalog.sync_folder` adds, updates (same ID, new version, probed again) and
removes; afterwards folders not reached are removed and empty ones pruned.

The loop runs once per file on disk (a home directory has millions), so it is
written for speed: `DirEntry` type checks need no system call, the extension
lookup is inlined, only media files and subdirectories are sorted, and
directories are only `stat`ed on Windows (for the hidden attribute).

`.ts`/`.mts` are also TypeScript extensions: such a file only counts as video
if it is not `*.d.ts`, is at least 1 KB, and its first bytes are MPEG-TS
packets (`probe.content_matches`).

### 3.4 Probing (`server/domain/prober.py`, `server/media/`)

A pool of worker threads (4 by default) reads each new or changed file's
header with `media.probe.probe()`: the extension picks the reader unless the
first bytes say otherwise (a PNG named `.jpg` is read as PNG). Readers never
raise for damaged files — the probe catches everything and keeps what it got.
Results are applied with `Catalog.apply_probe(id, version, meta, birth)`,
which ignores stale versions. While the scanner runs only one worker is
allowed at a time (they compete for the interpreter lock); all run afterwards.

What the readers extract (see `readers/__init__.py` for the keys):

- JPEG: SOF size; EXIF orientation, dates, camera, the IFD1 thumbnail
  (offsets are relative to the TIFF header and stored absolute).
- PNG (IHDR, acTL, eXIf), GIF (animation), WebP (VP8/VP8L/VP8X, EXIF), BMP,
  ICO, PSD, SVG (width/height or viewBox).
- TIFF and TIFF-based RAW: the largest embedded JPEG becomes the preview; RAF
  has its JPEG at a fixed offset.
- ISO BMFF: MP4/MOV duration (mvhd, or mehd, or the last fragment's
  tfdt + trun), creation time, video track size, rotation matrix and codec;
  HEIF/AVIF primary item `ispe`/`irot` and its Exif item.
- Matroska/WebM: Info and Tracks (through the SeekHead when they follow a
  Cluster), DateUTC. AVI: `avih`, `strh`, `strf`, `dmlh`.

`displayWidth/displayHeight` are the size as shown (orientation 5–8 and
rotations of 90/270 swap them). EXIF dates are **wall-clock** times (no zone);
video creation times are real instants (`takenUtc`). Birth time comes from
`st_birthtime`, Windows `st_ctime`, or Linux `statx` via ctypes
(`lib/filetimes.py`); Linux `st_ctime` is never used as a creation date.

### 3.5 The catalog and its wire format (`server/domain/catalog.py`)

Items and folders live in lists indexed by ID (IDs are never reused within an
album). Every change stamps the entry with the next revision; `delta(since)`
returns what changed after `since` (0 = everything, `full: true`), including
`removedItems`/`removedFolders`. Items are updated **in place** (a test that
keeps a reference sees the new values). Names that are not valid UTF-8
(surrogate escapes) are sent through `display_name()`.

Item on the wire (short keys, optional ones omitted):

| Key | Meaning | Key | Meaning |
| --- | --- | --- | --- |
| `i` | item ID | `w`, `h` | display width/height |
| `d` | folder ID | `u` | duration (s) |
| `n` | file name | `t` | taken (Unix seconds) |
| `f` | format key | `z` | 1 when `t` is a real instant (video) |
| `s` | size (bytes) | `b` | birth (creation) time |
| `m` | modified (Unix s) | `o` | EXIF orientation when not 1 |
| `v` | version (changes with the file) | `c`, `k` | camera, codec |
| `x` | 1 if hidden (dot name or dot folder) | `a` | 1 if animated |
| `p` | 1 once probed | `r` | preview: 1 small (EXIF thumb), 2 large (RAW) |

Folder: `{ i, p (parent or null for the root), n, x }`.

### 3.6 HTTP (`server/web/`)

`LurkerHTTPServer` is a `ThreadingHTTPServer` speaking HTTP/1.1 keep-alive
(one thread per connection). For HTTPS it does **not** wrap the listening
socket: each connection's thread peeks at the first byte — `0x16` means a TLS
handshake, done there with `wrap_socket(server_side=True)`; anything else is
plain HTTP and gets a `307` to `https://`. The wrapped socket takes over the
file descriptor, so `finish_request` closes it itself. Open connections are
tracked so `close()` can shut idle keep-alive sockets and event streams.

`dispatch.WebApp.handle`: parse (`request.py`: segments decoded one by one),
route (`router.py`), **guard even unknown paths** (`guard.py`), call, and write
(`respond.py` adds security headers and gzips large text). Unread request
bodies are drained before answering, or keep-alive breaks.

`guard.py`: with a password, only `public` routes pass without a valid
session (API → `401 auth_required`, pages → `303 /login?next=`). Without a
password, the `Host` must be an IP, `localhost`, a single label, a local suffix
(`.local`, `.lan`, `.home.arpa`…) or this machine's name, else `421`: that
blocks DNS rebinding, which needs a public domain. Any state-changing request
with a cross-site `Origin`/`Sec-Fetch-Site` is `403 cross_site`; JSON routes
also require `Content-Type: application/json`.

`files.py` streams media with `ETag`/`Last-Modified`, `If-None-Match`,
`If-Modified-Since`, `If-Range` and single `Range` requests (206/416; multiple
ranges get the whole file). It opens with `O_NOFOLLOW` (a file swapped for a
symlink after the scan is 404) and uses `sendfile` except over TLS. Media
responses carry a `sandbox` CSP.

### 3.7 Passwords (`server/domain/auth.py`)

`login` compares SHA-256 digests with `hmac.compare_digest`, returns a
`token_urlsafe(32)` session bound to the IP and a hash of the User-Agent.
Failures per IP: three free, then 1, 2, 4… up to 60 s (`429` with
`Retry-After`). Idle sessions expire after 7 days; all die with the process.
`logout` publishes `SESSION_ENDED`, and the SSE hub closes that session's
streams. The login page (`web/loginpage.py`) is server-rendered, works without
JavaScript, and uses a per-response CSP nonce for its inline style.

### 3.8 Live updates (`server/web/sse.py`, `public/js/core/live.js`)

`GET /api/events` is a `text/event-stream` (`Connection: close`, no length).
Every `ALBUM_CHANGED` marks each stream dirty; a stream sends the current
`album.status()` as `event: state` at most every 0.2 s, and `: ping` every
15 s. The status carries the catalog `rev`; the client (`core/catalog.js`)
fetches `GET /api/album/delta?album=&since=<rev>` itself. A full delta is
encoded and gzipped once per revision and shared (`routes/album.py`).

### 3.9 The client (`public/js/`)

- `main.js` → `app.js` (`App`): the shell. The server status drives the screen
  (start or album); the URL hash (`core/router.js`) holds every setting:
  `#/<view>?kind=&q=&types=&date=&from=&to=&minsize=&maxsize=&orient=&minmp=
  &mindur=&maxdur=&hidden=0&viewable=1&animated=1&camera=&sort=&dir=&layout=
  &size=&folder=&sub=1&group=&item=`. Defaults are left out of the URL.
- The visible list is `filterItems` + `sortItems` (`core/query.js`, pure),
  memoised per catalog version and settings.
- Views render rows through `core/virtual.js` (only rows near the viewport
  exist; a row whose key and `data` objects are unchanged is kept) and tiles
  through `components/tile.js`.
- Opening an item only pushes `item=<id>` onto the URL; the route handler opens
  the viewer (`components/viewer.js`) on the view's `sequence()`. The back
  button therefore closes it, and links to an item work.
- "Best" date (the default sort and date filter) = the capture date, else the
  **earlier** of creation and modification: copying a file renews its creation
  time and keeps its modification time.
- Everything the interface builds uses `h()`/`svg()` from `core/dom.js`
  (`textContent` only). There is deliberately no way to insert HTML: file names
  come from disk. Styles are set through the CSSOM (`el.style.x`), which the
  page's CSP (`style-src 'self'`) allows; never `setAttribute('style')`.

---

## 4. HTTP API

| Method and path | Purpose |
| --- | --- |
| `GET /login` · `POST /login` (public) | The password form; `password`, `next` (same-site paths only). |
| `POST /api/auth/logout` | End this browser's session. |
| `GET /api/state` | `{ app, album, formats, shortcuts }`. |
| `GET /api/events` | Server-sent `state` events (the album status). |
| `POST /api/paths/check` `{path}` | `{ ok, path, code, message, name }`. |
| `GET /api/paths/suggest?path=` | Directory completions. |
| `POST /api/album/open` `{path}` | 202 + status; 400 with the path check's code; 409 `album_open`. |
| `POST /api/album/close` `{}` | 200 + the empty status (idempotent). |
| `POST /api/album/rescan` `{album}` | 202; 409 `busy` while scanning. |
| `GET /api/album/delta?album=&since=` | Catalog delta; 409 `album_changed`, 404 `no_album`. |
| `GET /api/items/<album>/<id>` | Everything about one item, EXIF details read on demand. |
| `GET /media/<album>/<id>/<version>/<name>[?download=1]` | The file (inline, or as an attachment). |
| `GET /thumb/<album>/<id>/<version>` | The embedded JPEG preview, orientation injected; 404 `no_preview`. |
| `GET /`, `/icon.svg` (public), `/css/*`, `/js/*` | The application. |

Album status: `{ status: 'empty', recent, notice }` or `{ status: 'scanning' |
'ready', id, root, name, rev, openedAt, counts: { items, images, videos, bytes,
probed, folders }, scan: { rescan, directories, files, skipped, errors,
current, startedAt, finishedAt, seconds }, probe: { done, total } }`.

---

## 5. Things that cost time to discover

Each was a real bug or trap. The fix is in place; the note keeps it fixed.

1. **Announce before starting threads.** `open()` used to start the scan and
   then publish `ALBUM_OPENED`; a small directory finished first, so
   `SCAN_FINISHED` arrived before the album was "opened" (seen in the logs and
   in a parallel test run). Publish first.
2. **A home directory is mostly not media.** Scanning `~` (182 000 folders,
   1.3 M files) took 56 s: 74 000 TypeScript `.ts` files were opened for the
   MPEG-TS check, a `stat` per subdirectory looked for a hidden attribute only
   Windows has, and whole listings were sorted. Now 18 s including all probing.
3. **Probing starves the walk.** Four probe threads fighting the scanner for
   the GIL doubled the walk time; one probe worker runs during a scan.
4. **Poster queues must follow the screen.** A LIFO queue served the bottom of
   the screen first (tiles are created top to bottom), and the virtual list's
   off-screen rows jumped the queue. Tiles now report visibility through an
   IntersectionObserver (whose `rootMargin` cannot see past a nested
   scroller's clipping), and visible requests are served top to bottom.
5. **A removed `<img>` keeps downloading.** After a fast scroll across 67 000
   items, the browser was still fetching thousands of images for rows long
   gone and the visible ones waited. Tiles start their download only after
   60 ms mounted and `release()` removes every `src`.
6. **Aborting is an error.** Removing the `src` of an upgrading image fires
   its error path, which used to mark the file (and a whole "maybe" format)
   as unviewable. Everything checks the tile's `released` flag first.
7. **The viewer and history.** `open` replaced the URL (from `onNavigate`)
   before the click pushed it, so no history entry was created and Back left
   the app. Opening now only pushes the URL; the route opens the viewer.
8. **A `<dialog>` in a background tab** may not deliver its `close` event
   (seen in headless Chromium). The confirm dialog settles on the button clicks
   themselves.
9. **The static catch-all shadowed real routes**: `GET /api/album/open` was a
   404 and `POST /nowhere` a 405. Catch-alls are `fallback` routes now.
10. **File system "creation" is the copy date.** Sorting by
    taken → created → modified put every copied file at "today". The best date
    uses the earlier of created and modified.
11. **Rotation needs care twice**: EXIF orientation 5–8 and video rotation
    swap the display size (layouts use it), and embedded thumbnails carry no
    orientation, so `/thumb` injects a one-tag EXIF segment
    (`previews.with_orientation`) and the browser rotates it like the photo.
12. **Fragmented MP4** (screen recorders, MediaRecorder) has no duration in
    `mvhd` and often no `mehd`: the last `moof`'s `tfdt` plus its `trun`
    sample durations (or `trex` defaults) give it.
13. **Test harness traps**: `Runtime.evaluate(returnByValue)` returns `{}` for
    a DOM element (falsy in Python — `wait_for` special-cases it);
    `Page.navigate` to the same URL with a hash is not a load (use
    `page.reload()`); headless Chromium uses the host time zone, so browser
    tests force UTC; background tabs are throttled (`page.front()`).
14. **Cookies ignore ports**: two Lurkers on one machine shared a cookie name
    and logged each other out. The name includes the port.

---

## 6. Tests

```bash
python3 -m unittest discover -s tests -t .                 # everything, ~50 s
python3 -m unittest tests.test_media                       # one file
LURKER_SKIP_BROWSER_TESTS=1 python3 -m unittest discover -s tests -t .
LURKER_TEST_SCREENSHOTS=/tmp/shots python3 -m unittest tests.test_browser
```

| File | Tests | Covers |
| --- | --- | --- |
| `test_cli.py` | 19 | bare-word and dashed options, defaults (HTTPS, 8080, `cert/`), errors |
| `test_startup.py` | 13 | the port walk (busy ports, port 0, other errors, the bound), the real CLI twice, `dir` valid and invalid, SIGTERM |
| `test_cert.py` | 13 | ASN.1, RSA keys and signatures, the certificate (openssl, TLS handshake verified by name and IP), replacement on every start |
| `test_media.py` | 36 | every reader, EXIF details and dates, previews, sniffing, and ~3 000 truncated/corrupted/garbage files that must not crash |
| `test_real_media.py` | 4 | the readers against files from ffmpeg and ImageMagick (skipped without them) |
| `test_album.py` | 25 | path checks and suggestions, the recursive scan, lazy folders, hidden files, symlinks, TypeScript, unreadable folders, revisions and deltas, rescans, close while scanning, concurrent readers |
| `test_http.py` | 29 | static files and traversal attempts, security headers, the API, media streaming (ranges, conditional requests, HEAD, previews), keep-alive with bodies, the cross-site and host guards |
| `test_auth.py` | 15 | sessions bound to IP and User-Agent, throttling, logout, everything locked before login, `next`, cookie flags |
| `test_https.py` | 5 | verified TLS end to end, `http://` redirected, refused certificates and silent clients, old TLS refused |
| `test_sse.py` | 5 | initial and later states, throttling, every browser hears a close, logout ends the stream, shutdown ends streams |
| `test_browser.py` | 18 | the whole interface in headless Chromium: start screen, grid, posters, filters, sorting, every view, the viewer (zoom, rotate, info, video, slideshow, Back), shared close, rescan, password, phone layout, client-side logic |

`tests/support/fixtures.py` builds every media file byte by byte (a real
baseline JPEG encoder for solid blocks, EXIF writer, PNG, GIF, BMP, and the
container headers) plus a sample album (`make_album`). `tests/support/server.py`
starts a real Lurker on port 0 with a temporary certificate directory.

**When you change behaviour, add a test that fails without the change.**

---

## 7. Conventions

- Python: 4 spaces, single quotes, docstrings that say *why*, ~120 columns.
  Standard library only. `AppError` for anything a user should read.
- JavaScript: ES modules with `.js` extensions, 2 spaces, single quotes,
  semicolons, JSDoc where a contract matters. No `innerHTML`, no inline
  styles, no storage APIs.
- CSS: tokens in `css/base.css` (light and dark), one file per area. The
  viewer is always dark. `[hidden]` is `display: none !important` on purpose.
- Every interface string is English.

## 8. Deliberate non-goals

Do not add these without being asked; each contradicts something above.

- Writing to the album: deleting, renaming, moving, editing or uploading.
- Server-side thumbnails or transcoding (that needs a decoder library).
- Following symbolic links inside the album.
- Several albums in one process, or per-user albums.
- Storing anything: settings, sessions, thumbnails, recent directories.
- Accounts or users beyond the single shared password.
- Any package, framework, build step or CDN.
