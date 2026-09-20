# Frisbee maintenance guide

This file applies to the entire `frisbee/` directory and is the entry point for
an assistant arriving with no conversation context. It applies equally to Codex,
Claude Code, or another coding assistant; `CLAUDE.md` only points here. Read
`README.md` for user-facing behavior and startup instructions.

`prompts/init.md` keeps the original prompt that produced the application; treat
it as history, not as a specification to re-execute. `LICENCE.txt` is an MIT
licence; do not add per-file licence headers or change its terms.

## Required constraints

- Communicate with the user in Spanish. Write source code, comments,
  documentation, and interface text in English.
- Use only Python, JavaScript, HTML, and CSS. Runtime Python code must remain
  compatible with Python 2.7 and Python 3 on Linux and Windows.
- Use the Python standard library only. Do not introduce installed packages,
  frameworks, package managers, a build pipeline, external assets, or CDNs.
- Starting `python app.py` must start the complete application. Node and
  Chromium are optional development-test tools, never runtime requirements.
- Keep the GUI simple, using native controls and modest CSS primarily for
  responsive layouts and dark/light themes. Dark is the initial default.
- Preserve unauthenticated sharing: no accounts, passwords, or artificial
  file-size quotas. Workspace IDs identify roots, not users or access rights.
- Notepad must work before workspace selection and remain accessible from
  every view and during transfers. Its state and lock are independent of files.
- Keep filesystem responsibilities in services and HTTP responsibilities in
  the adapter. Explain non-obvious behavior with descriptive English comments.
- The browser side is exactly three files: `static/index.html`, `static/app.css`,
  and `static/app.js`. The server has no directory-serving fallback, so a fourth
  asset does not exist until its route is added to the allowlist in `server.py`.

## Start and validate

Run commands from this directory:

```text
python app.py
python app.py --host 127.0.0.1 --port 8080 --data-dir /path/to/test-data
python -m unittest discover -s tests -v
python -m unittest tests.test_storage -v
```

Default binding starts at `0.0.0.0:8080`. If occupied, startup tries 8081, 8082,
and successive ports until one binds. Use the actual port printed at startup;
a peer device connects to the host's LAN IP with that port.
The data directory defaults to the directory containing `app.py`, even when
started from another shell directory. `--data-dir` overrides storage location.
Assets always come from this application's `static/` directory. Routes assume
deployment at the HTTP origin root, not under a path prefix.

The suite is 47 tests and finishes in seconds; run all of it after any change
under `frisbee_core/`. The Python tests use temporary directories and real
ephemeral localhost ports. A sandbox may need permission to bind/connect
sockets. Do not mistake that environment failure for an application failure or
skip the HTTP coverage.

`tests/browser.mjs` is an optional, dependency-free Node 24 + Chromium DevTools
runner. See `README.md` for its three-process setup. It must use disposable data
and a separate Chromium profile: it performs real file operations and clears
the test origin's local storage. The base URL comes from its first argument,
then `FRISBEE_TEST_URL`, then `http://127.0.0.1:8765`; `FRISBEE_DEBUG_URL`
overrides the default debugging URL at `http://127.0.0.1:9229`.
If test-server port fallback occurs, pass the actual advertised server URL;
never point a destructive browser test at another process on the original port.

Initial validation on 2026-09-19: 42 Python tests passed on Linux/Python 3.10.
Chromium 153 exercised notes, file/folder uploads, text/image/binary previews,
rename, ZIP, moves, confirmed deletion, themes, and desktop/tablet/mobile layouts
down to 320 pixels. Python sources were also parsed using `lib2to3`'s compatible
grammar. Windows junction behavior has isolated simulations. Python 2.7 and
Windows were not available for native execution; do not claim they were tested
merely because syntax checks and simulations passed. Re-checked on 2026-09-20
with Python 3.10.12: the 42 tests still pass and every runtime and test module
still parses with the Python 2 grammar; the browser runner was not re-run.

Media/filter update on 2026-09-20: all 47 Python tests pass. The expanded
Chromium 153 runner also passes, including decoded image/video thumbnails,
native WebM playback and seeking, default checkbox states, hidden-folder-only
filtering, case-insensitive live search, visible-only selections, preservation
of search after file previews/refresh/Notepad, clearing after directory changes,
and responsive media lists at tablet and 320-pixel widths. No browser exceptions
were observed. All 12 Python modules still parse with the compatible grammar;
native Python 2.7 and Windows execution remain unverified on this Linux host.

## Layering and error contract

```text
static/app.js
  -> RequestHandler._dispatch route table            frisbee_core/server.py
     -> WorkspaceStore / FileStore / NoteStore       frisbee_core/storage.py
     -> JobStore worker threads                      frisbee_core/jobs.py
        -> os / shutil / zipfile through helpers     frisbee_core/compat.py
```

- Services never import `server.py`, never touch HTTP, and never log. They take
  Unicode paths, return plain dictionaries, and are usable without a server.
- The adapter performs no filesystem logic of its own. It resolves an absolute
  path through a service (`FileStore.raw_file`) and only streams bytes.
- Expected failures are `StorageError(message, status)`. The `@filesystem_errors`
  decorator maps `OSError`/`IOError`/`UnicodeError` onto 403/404/409/400 and
  deliberately lets programming mistakes escape as 500. Do not catch bare
  `Exception` inside a service to make an error look tidy.
- The adapter turns any `StorageError` into `{"error": message}` with its status;
  `api()` in the browser raises an `Error` whose `.message` reaches `notify()`.
  A user-facing message therefore comes from the service that detected the fault.

## Modules and extension points

| File | Responsibility |
| --- | --- |
| `app.py` | CLI options, automatic port selection, actual network address hints, SIGTERM/Ctrl+C shutdown |
| `frisbee_core/compat.py` | Text types, filesystem decoding, atomic replacement, Windows reparse detection, safe removal |
| `frisbee_core/storage.py` | `WorkspaceStore`, `FileStore`, `NoteStore`, path validation, revisions, ZIP/upload storage |
| `frisbee_core/jobs.py` | `JobStore`: background moves, preparation, copying, progress, completion/error state |
| `frisbee_core/server.py` | `FrisbeeServer`, the `RequestHandler` route table, `ArchiveStore`, static assets, byte streaming, server construction and port fallback |
| `static/index.html` | Native forms, directory table, preview/editor panels, permanent navigation |
| `static/app.css` | Color themes, responsive table/cards, editors, sticky application navigation |
| `static/app.js` | Separate workspace/file/note/transfer state and browser interactions |
| `tests/support.py` | `TemporaryDirectoryTestCase` and `HTTPTestCase` (ephemeral server, `request`, `json_request`, `query`) |
| `tests/test_*.py` | Storage, HTTP, compatibility, and move-recovery coverage |
| `tests/browser.mjs` | Optional Chromium DevTools regression run; never a runtime dependency |

Recipes for common changes:

- **New filesystem feature:** write the service method first (decorate it with
  `@filesystem_errors`, validate with `normalize_relative`/`_single_name`, hold
  `FileStore.lock`, and publish writes through `_write_atomic`/`atomic_replace`),
  add one branch to `_dispatch`, then the browser interaction, then tests in
  `test_storage.py` and `test_http.py`. Reuse the existing validation, error, and
  locking helpers instead of writing a parallel set.
- **New route:** insert it into the `_dispatch` chain above the final
  `StorageError('This endpoint does not exist.', 404)`. Read JSON with
  `self._body()` plus `self._required(body, 'field')`, read the query with the
  local `parameter(...)`, and answer with `self._json(payload, status)`. Every
  non-GET method has already passed `_origin()` at that point.
- **New static asset:** extend the allowlisted route map in `_dispatch`
  (`/`, `/index.html`, `/app.js`, `/app.css`, `/static/app.js`, `/static/app.css`)
  with the path and its MIME type, and reference it from `index.html` with an
  absolute `/static/...` URL. An unregistered file returns 404, not the file.
- **New long-running operation:** model it on `JobStore`. Answer 202 with a job
  identifier, keep progress under `JobStore.lock`, keep filesystem work under
  `FileStore.lock`, and let the browser poll a small `GET`.
- **New process-level resource:** build it in `create_server()`, attach it to the
  server instance, and release it in `FrisbeeServer.server_close()`.
  `create_server()` constructs a server without starting its loop, so tests and
  embedders can bind port zero and control the lifecycle themselves; keep that
  separation when adding startup work, and keep it out of `app.py`.
- **New directory-table column:** add the `<th>` in `index.html`, the
  `cell("Label", value)` call in `renderEntries()`, and a matching
  `#file-table td[data-label="Label"]::before` rule in the mobile block of
  `app.css`. The phone layout is generated entirely from `data-label`.

## Automatic startup port selection

- The CLI calls `create_available_server(host, port, base_dir)`. Its default
  starting port is 8080; each occupied port advances the candidate by exactly
  one. An explicit `--port N` uses the same behavior starting at N.
- Bind the real server on each attempt. Do not probe availability with a
  separate socket and then bind again: another process could take that port
  between those operations. The successfully constructed server owns its port.
- Retry only address-in-use errors: POSIX `errno.EADDRINUSE` and Windows
  Winsock 10048. Python 2/Windows can expose the code in `errno`, `winerror`, or
  the exception's first argument. Permission errors, invalid host addresses,
  and unrelated failures must stop startup instead of triggering a port scan.
- Port 0 remains an explicit request for an operating-system-assigned port.
  Never increment it to port 1. Port 65535 is the upper boundary; exhausting
  the range produces a clear error without attempting an invalid port 65536.
- `create_server()` deliberately retains strict binding for tests and callers
  requiring an exact port. Put fallback policy in `create_available_server()`;
  keep resource construction in `create_server()` and serving in the caller.
- Startup output uses `server.server_address[1]` for every displayed URL and
  announces when the requested nonzero port was replaced. Do not print 8080 or
  the requested port when the socket was actually bound somewhere else.
- `tests/test_startup.py` covers retry classification, range limits, actual
  occupied localhost ports, and CLI startup/output with an HTTP health check.

## Storage and state

- `<data-dir>/workspace/` is the local virtual workspace. It is created on
  selection. Absolute-directory and host-root selections must be readable and
  listable before acceptance. Host root is `/` or the Windows system drive.
- `<data-dir>/notepad/<name>.txt` stores notes as ordinary UTF-8 files. API names
  omit the added `.txt` suffix. Notes use portable filename restrictions.
- `workspace/`, `notepad/`, bytecode, and cache directories are ignored by Git.
  Never commit user data or add test fixtures to live runtime directories.
- Workspace IDs, move jobs, and archive registrations live in memory.
  Each tab selects its own workspace; reloading the page returns to the chooser.
  Finished move records are discarded 24 hours later, but only when a new move
  starts; archives older than 30 minutes are reaped when a new archive is built.
- Browser local storage holds only `frisbee.theme` and `frisbee.absolutePath`.
  Every access is wrapped in try/catch because private browsing can throw.
  Editors and transfers use in-memory state. Switching the two main views
  preserves both editor drafts, with discard/beforeunload confirmation. The note
  list loads lazily on the first Notepad visit (`state.notesLoaded`).
- Creation dates use birth time where available, or Windows creation time.
  Linux `st_ctime` is not a creation date, so `created` is usually `null` there.
  Directory counts include direct files only; unavailable metadata must not
  prevent listing other entries.

## API contracts

Successful JSON responses are direct objects; errors are `{ "error": "..." }`.
Mutations require JSON `Content-Type` except raw uploads. Every request that
carries a body needs a `Content-Length`; `Transfer-Encoding` is refused with 411. HTTP status
distinguishes bad input, unavailable paths, denied access, and conflicts. JSON
bodies are UTF-8 and responses are ASCII-escaped. All API file paths are relative
to the selected root with `/` separators; `""` means the root. Native absolute
paths appear only in workspace selection.

| Method and route | Inputs and result | Success |
| --- | --- | --- |
| `POST /api/workspaces` | `{mode: local/absolute/host, path?}` -> `{workspace: {id, root, mode}}` | 201 |
| `GET /api/workspace` | `workspace` query -> `{workspace}` | 200 |
| `GET /api/files` | `workspace, path` query -> `{path, parent, entries}` | 200 |
| `GET /api/content` | `workspace, path` query -> `{path, content, revision}` | 200 |
| `PUT /api/content` | `{workspace, path, content, revision?}` -> saved content and revision | 200 |
| `GET /api/download` | `workspace, path` query -> attachment with range support | 200/206 |
| `GET /api/preview` | `workspace, path` query -> image or recognized video with restricted content policy | 200/206 |
| `POST /api/upload` | `workspace, path, name` query; raw body + Content-Length -> `{path, size}` | 201 |
| `POST /api/directories` | `{workspace, path, name}` -> `{path}` | 201 |
| `POST /api/rename` | `{workspace, path, name}` -> `{path}` | 200 |
| `POST /api/delete` | `{workspace, paths}` -> `{deleted: [...], errors: [...]}` | 200 |
| `POST /api/move` | `{workspace, paths, destination}` -> `{job}` | 202 |
| `GET /api/jobs/<id>` | -> `{job}` | 200 |
| `POST /api/archives` | `{workspace, paths}` -> `{download_url}` | 201 |
| `GET /api/archives/<id>` | -> disk-backed ZIP attachment with range support | 200/206 |
| `GET /api/notes` | No name -> `{notes}`; `name` query -> `{name, content, revision}` | 200 |
| `POST /api/notes` | `{name, content}` creates a note, rejecting existing names | 201 |
| `PUT /api/notes` | `{name, content, revision?}` updates an existing note | 200 |
| `DELETE /api/notes` | `name` query -> `{deleted: name}` | 200 |
| `GET /api/health` | -> `{status, application}` | 200 |

Entries include `name`, `path`, `kind` (`directory`, `file`, or `other`), `size`,
`created`, `file_count`, `readable`, `is_link`, and `preview` (`text`, `image`,
`video`, or `binary`). A job includes `id`, `status` (`running`, `done`, `error`),
`completed`, `total`, `bytes_done`, `bytes_total`, `errors`, `message`, and an
`updated` epoch timestamp. Each listed note includes `name`, `size`, and
`modified`. The destination of a move is an existing workspace-relative
directory. Deletion may partially succeed; always show its per-item errors.
UI deletion requires confirmation for notes and all selections.

Only these routes exist. `GET` also answers the static allowlist described
above, and `HEAD` reuses every `GET` route with metadata and no body.

## HTTP adapter rules

- Every response carries `Cache-Control: no-store`, `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and
  `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src
  'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'`. That policy rejects inline `<script>` and `<style>`
  blocks, `style="..."` attributes, and `onclick=`-style handlers. Build
  behavior in `app.js`, toggle a class, and style the class in `app.css`.
- `_headers()` appends its `extra` mapping after the defaults, so a repeated
  name is sent twice. `/api/preview` depends on that: its extra
  `sandbox; default-src 'none'` intersects with the default policy. Never use
  `extra` expecting it to replace a default header.
- `protocol_version` is `HTTP/1.0`, so each response closes the connection and
  an unread upload body can never be parsed as the next request. Do not switch
  to HTTP/1.1 without draining request bodies on every error path.
- `log_message()` is overridden to discard all request and error logging because
  query strings carry host paths and filenames. Keep it silent.
- `_fail()` cannot rewrite a response that already started streaming; it closes
  the connection instead. Validate everything before writing the first byte.
- `_stream()` serves every file response (static assets, downloads, previews,
  archives) in 1 MiB chunks with `Accept-Ranges`, single-range support, 416 for
  unsatisfiable ranges, and both `filename=` and `filename*=UTF-8''` on
  attachments. It seeks, so its source must be a real seekable file object.
- `_origin()` runs for every non-GET method. It is a same-origin guard, not
  authentication; keep it and do not present it as access control.

## Concurrency and locks

- One daemon thread per request (`ThreadingMixIn`, `daemon_threads = True`).
  Move workers are separate daemon threads that `JobStore.close()` joins from
  `server_close()`, so Ctrl+C waits for in-flight copies instead of truncating.
- `FileStore.lock` (an `RLock`) is held for a whole listing, upload, ZIP build,
  and move job. Accept the consequences rather than "optimizing" them away: a
  running move or a slow upload blocks other file requests, and concurrent
  uploads serialize. The browser uploads sequentially for the same reason.
- `JobStore.lock` protects only progress metadata, so `GET /api/jobs/<id>`
  answers while a move holds the file lock. `NoteStore.lock` is separate, so the
  notepad keeps working during transfers. `WorkspaceStore._lock` guards only the
  identifier map. Never take `FileStore.lock` while holding one of the others.
- Downloads stream outside `FileStore.lock`; the handler only resolves the path
  under it. Keep new read-only streaming endpoints on that side of the lock.
- `ArchiveStore` gives each archive its own lock. Reaping skips an archive that
  is being downloaded (`acquire(False)`), and two simultaneous downloads of one
  archive serialize because they share a single file object and seek position.

## Data integrity and portability rules

- Validate both lexical paths and resolved targets. Reject traversal and root
  mutation. Do not replace the separator-aware boundary check with a naive
  string prefix comparison. Never render untrusted names with `innerHTML`.
- `normalize_relative()` applies Windows name rules only on Windows, while note
  names always pass `_windows_name()` so a notepad stays portable between hosts.
  Keep that asymmetry: workspaces expose an existing filesystem, notes create it.
- Use `fs_text(__file__)` before composing Unicode paths on Python 2. Avoid
  f-strings, annotations, pathlib in runtime code, Python-3-only exceptions,
  async Python syntax, or imports that have no version-compatible alternative.
- Keep `from __future__ import unicode_literals` in every runtime module, use
  `string_types`/`text_type` from `compat.py` instead of bare `str`, and keep
  the `long` fallback in upload-length validation. Call base-class methods
  explicitly (`Exception.__init__(self, ...)`, `HTTPServer.server_close(self)`):
  zero-argument `super()` is Python 3 only and several standard-library bases
  are old-style classes on Python 2.
- Windows before Python 3.8 cannot reliably resolve reparse points. Preserve
  `assert_resolvable` checks. Use `is_linklike` and `safe_remove_tree`; old
  Windows `islink`/`realpath` and recursive `shutil.rmtree` are insufficient to
  avoid following junction destinations. Modern internal links are supported.
- Uploads stream to a temporary file beside the target. Flush before publishing,
  reject collisions, clean up partial data, and preserve folder paths. A name
  ending in `/` with length zero creates an empty directory. Native folder
  inputs generally omit empty folders; entry-based drag/drop can preserve them.
- Text editing supports UTF-8 and BOM-marked UTF-16/32. Preserve BOM/endianness
  and existing mode bits. Revisions are SHA-256 of disk bytes; a stale editor
  save returns 409 rather than discarding another device's work.
- ZIPs are built in disk-backed temporary files, stream source data, use ZIP64,
  include empty folders, and reject symlink cycles. Do not load downloads into
  browser blobs. Archives over 30 minutes old are reaped on new archive creation;
  all are closed on normal server shutdown.
- Same-volume moves use rename. EXDEV/cross-volume moves copy in chunks into a
  temporary destination, publish only a complete copy, then remove the source.
  Preserve the original after failed copying. If original removal fails after
  publication, report the duplicate copies instead of deleting the destination.
  `JobStore._size()` walks the whole selection first and is the pre-flight check:
  it rejects special files and unmovable reparse points before any byte is
  copied, so keep new source kinds rejected there rather than mid-copy.
- External programs can change files while Frisbee operates. Internal locks and
  revision checks are not a cross-process filesystem transaction. Windows ACLs,
  POSIX ownership, and all extended metadata are not exhaustively reproduced by
  standard-library cross-volume copies; do not claim complete metadata cloning.
- Keep no-auth operation intentional. Same-origin mutation checks prevent
  unrelated browser pages from issuing writes; they are not an authentication
  mechanism. Downloads use attachment headers, UTF-8 filenames, and nosniff.

## Browser application rules

`static/app.js` is a single strict-mode IIFE loaded with `<script defer>`. It is
not an ES module: it has no imports or exports, and the CSP would block an inline
module anyway. Match its existing syntax, which uses `var`, function expressions,
and string concatenation rather than `const`, arrow functions, or template
literals. The newest browser APIs it relies on are `async`/`await`, `Set`,
`URLSearchParams`, `replaceChildren()`, and `requestSubmit()`, which together set
the supported baseline at evergreen browsers from about 2022 onward.
`tests/browser.mjs` is the only JavaScript file that may use modern module
syntax, because Node 24 runs it instead of a browser.

- All server calls go through `api(endpoint, method, body)` with URLs built by
  `apiUrl()`/`workspaceUrl()`. The single exception is `uploadOne()`, which needs
  `XMLHttpRequest` for upload progress. Do not call `fetch` from a handler.
- Register handlers with `listen(id, event, callback)`; it routes thrown errors
  and rejected promises to `reportError()` and then `notify()`. `makeButton()`
  does the same for generated buttons and always writes labels with `textContent`.
- `notify(message, kind)` is the only status channel, and `window.confirm` /
  `window.prompt` are the only dialogs. `tests/browser.mjs` queues every expected
  dialog in `expectedDialogs` and fails on an unexpected one, so adding,
  removing, or reordering a confirmation means updating that runner too.
- Controls disabled during a workspace operation carry `data-workspace-action`;
  controls that need a selection carry `data-selection-action`.
  `setWorkspaceBusy()` and `updateSelection()` drive both, and generated controls
  must set the attribute and their initial `disabled` from `state.busy`
  explicitly. Never mark the navigation tabs, the theme toggle, or notepad
  controls with either attribute; the notepad stays usable during transfers.
- `state` keeps workspace, file, note, and transfer concerns apart, and
  `state.selected` is a `Set` of workspace-relative paths. `beforeunload` warns
  while `fileDirty`, `noteDirty`, or a transfer is live.
- Out-of-order responses are discarded with monotonic counters
  (`state.noteRequest`, `state.destinationRequest`). Reuse that pattern for any
  new asynchronous panel instead of trusting arrival order.
- Ctrl/Cmd+S saves the visible editor: the note form in Notepad, the file editor
  in a text preview. Keep that binding when adding another editor.
- Move polling retries transient network failures against the same job id and
  never re-posts a move; only a 4xx aborts the poll loop.
- Theme lives in `document.documentElement.dataset.theme`, with variables under
  `:root` and `:root[data-theme="light"]`. There is no `prefers-color-scheme`
  override because dark is the product default.

## Directory filters and media previews

- Toolbar checkbox `#show-previews` ("Show media previews") starts unchecked;
  `#hide-hidden-folders` ("Hide hidden folders") starts checked. They map to
  `state.showPreviews` and `state.hideHiddenFolders`. Their values survive
  directory changes within the current page, but are not saved in local storage.
- Hidden-folder filtering hides only entries with `kind === "directory"` and a
  name beginning with `.`. Do not hide dotfiles or change the server listing.
- `#directory-search` updates `state.searchQuery` on every input event.
  `visibleEntries()` applies both filters to `state.entries`, using a
  case-insensitive substring match on names. It searches only the current
  directory, never descendants, file contents, or notes.
- `resetDirectorySearch()` runs after successful navigation to a different
  directory and after a successful workspace choice. Opening a file and using
  **Back to directory**, refreshing the same directory, switching to Notepad,
  or a failed directory request preserves the search. Do not clear it simply
  because the table is re-rendered.
- `pruneSelection()` removes paths excluded by the current filters. Select-all,
  its checked/indeterminate/disabled state, and bulk-action counts use visible
  entries. Filtering must never leave invisible entries queued for deletion or
  moving. An empty filtered result has its own message and disables select-all.
- `makeMediaThumbnail()` creates small clickable images/videos only for visible
  media files while previews are enabled. Images use native lazy loading; video
  thumbnails are muted and paused, preload metadata, and may seek a fraction of
  a second to request their opening frame. The default listing must not request
  thumbnail media at all. Unsupported thumbnails show a readable fallback.
- `#video-preview` contains `#preview-video`, a native `<video>` with `controls`,
  `playsinline`, and metadata preloading. Open it for `preview === "video"`,
  using `/api/preview` as its source. Playback is user-initiated; unsupported
  formats/codecs show an explanation and retain the download action.
- `releaseMedia()` pauses videos, removes sources, and calls `load()` to release
  resources before replacing thumbnails, closing a file, or changing workspaces.
  Switching to Notepad pauses the main player while retaining its position.
  Avoid hidden background playback or requests from discarded media elements.
- `FileStore.MEDIA_TYPES` and `FileStore.media_type(name)` are the shared source
  of recognized image/video extensions and deterministic MIME types. Detection
  ignores extension case; `.m4v` maps to `video/mp4` consistently on Windows and
  Linux. Extend this mapping when adding formats, not a second HTTP-only list.
  Ambiguous `.ts` remains available as TypeScript text and `.ogg` is not assumed
  to be video; Ogg video uses `.ogv`.
- `/api/preview` streams media through `_stream()` with existing HEAD and byte
  range support, without attachment headers. Browser decoding handles playback;
  never add a transcoder, external library, or full-file buffering. Recognizing
  a container does not guarantee that every browser supports its codecs.

## Tests and verification

- `tests/test_storage.py` and `tests/test_jobs.py` call services directly;
  `tests/test_http.py` drives a real ephemeral server through `HTTPTestCase`;
  `tests/test_compat.py` covers link and reparse handling with local simulations;
  `tests/test_startup.py` covers port fallback and the CLI with temporary data.
  Subclass the helpers in `tests/support.py` rather than creating servers or
  temporary directories by hand, and never touch `workspace/` or `notepad/`.
- Add focused regression tests for data-loss risks and meaningful behavior:
  path boundaries, revision conflicts, partial uploads, cross-volume recovery,
  status codes, and streaming edge cases. Avoid tests that restate CSS or markup.
- Use temporary data. Stop temporary test servers and browsers when finished,
  and remove stray `frisbee-test-*` directories a crashed run may have left.
- Layout-only changes need visual inspection at desktop, tablet, and 320-pixel
  widths; `tests/browser.mjs` asserts the absence of horizontal overflow there.
- The browser runner embeds a tiny synthetic WebM fixture to verify real video
  decoding, playback, seeking, and thumbnail behavior without an external media
  tool. Its network assertions check that disabled previews fetch no media.
  Keep search/filter coverage alongside those flows when altering table state.
