# Frisbee

> **This software was generated 100% using artificial intelligence** — specifically Codex + GPT-6 Astra, Ultra effort — on September 20, 2026. No skills were used during generation. The initial prompt used to create this application can be found in [`prompts/init.md`](prompts/init.md). Post-creation adjustments draw on both Codex GPT-6 Astra and Claude Code Opus 5.

A small file-sharing web application and persistent notepad. The host needs only
Python 2.7 or Python 3, using its standard library. Devices connecting to it need
a modern web browser. There are no packages to install, build steps, external
assets, accounts, or passwords.

## Start

From the `frisbee` directory, on Linux or Windows:

```text
python app.py
```

The server tries port `8080` first. If it is occupied, it automatically tries
`8081`, then `8082`, increasing by one until it binds a free port. The startup
message prints the actual URL: open that address on the host computer, or
`http://<host-LAN-IP>:<chosen-port>/` on another device on the same network.
The server listens on all IPv4 network interfaces by default. The host firewall
must allow inbound TCP traffic on the chosen port. Stop the application with
Ctrl+C.

Optional settings:

```text
python app.py --port 9000
python app.py --port 0
python app.py --host 127.0.0.1 --port 8080
python app.py --data-dir /absolute/path/to/frisbee-data
python app.py --data-dir "C:\Users\Alice\Frisbee Data"
```

`--port 9000` starts the same search at port 9000. `--port 0` asks the operating
system to assign an available port directly. Automatic retries apply only to
ports already in use; other startup errors are reported immediately. If every
port from the starting value through 65535 is occupied, startup reports that
no port is available.

The default data directory is the directory containing `app.py`, regardless of
the shell's working directory. `--data-dir` changes where the local workspace
and notes are stored; it does not change where application assets are loaded.
Frisbee deliberately provides unauthenticated HTTP: every device that can reach
the server can select host directories and operate with the Python process's
filesystem permissions. Use it on a network where that access is intended.

## Workspaces

Choose one of three roots:

1. **Local workspace:** `<data-dir>/workspace/`, created when selected.
2. **Absolute path:** an existing directory, such as `/home/alice/Documents`
   or `C:\Users\Alice\Documents`. The server checks readability and listing
   access before accepting it.
3. **Host root:** `/` on Linux or the Windows system drive root, usually `C:\`.

Each browser tab has its own workspace selection. Selecting a root does not
change other devices' workspaces. Reloading the page shows the chooser again.
Workspace identifiers last for the lifetime of the server; select the root
again after restarting the server.

Click directory names or breadcrumbs to navigate. The listing includes file
size, creation time when the operating system exposes it, and the number of
files directly inside each directory. Counts are not recursive. Missing or
unreadable metadata is shown as unavailable. Linux inode-change time is never
misrepresented as a creation date.

- **Show media previews** adds small image and video thumbnails to the listing.
  It starts unchecked; no thumbnail media is requested until it is enabled.
- **Hide hidden folders** starts checked and hides directories whose names begin
  with `.`. Uncheck it to show them. Dotfiles remain visible.
- **Search this directory** filters file and directory names as you type,
  ignoring case. It searches the current directory only. Moving to a different
  directory clears the search; opening a file and returning, refreshing the
  same directory, or visiting Notepad preserves it. Select-all and bulk actions
  apply only to visible entries, and filtered-out entries are deselected.
- Rename or delete an individual entry using its row controls.
- Select entries to download a ZIP, move them, or delete them together.
  Deletion always asks for confirmation in the interface.
- Choose an existing destination inside the current workspace for a move.
  The progress bar reports file-copy bytes and completed selections. A move
  within one filesystem can finish immediately using an atomic rename.
- Use **Upload files**, **Upload folder**, or drag files and folders into the
  directory. Folder structure is preserved. Existing files are never silently
  overwritten. Uploads stream to disk and show transfer progress.
- Use **New folder** to create an empty directory. Folder pickers depend on
  browser support and do not normally expose empty directories; drag and drop
  preserves empty directories when the browser exposes directory entries.
- Open text files to read, edit, save, or download them. UTF-8 and BOM-marked
  UTF-16/32 are supported. Files with other encodings remain downloadable.
- Open an image for a preview, or a video for the browser's native player with
  playback and seeking controls. Playback pauses when visiting Notepad and
  stops when leaving the file. Container and codec support depend on the browser;
  unsupported media remains downloadable. Videos are streamed directly without
  transcoding. Executables and other binary files show a download banner.

The interface defaults to dark mode. **Light mode** changes the theme and saves
that preference in the browser. The layout adapts to desktop, tablet, and phone
screens without hiding file metadata or actions.

## Notepad

**Notepad** remains available before choosing a workspace, while browsing, and
during transfers. Create, read, edit, and delete notes independently of the
current workspace. A note named `shopping` is saved as
`<data-dir>/notepad/shopping.txt`. Notes are shared across connected devices.
Names follow portable filename rules; the `.txt` suffix is added by the server.

Both editors detect conflicting saves using content revisions. If another
device changes a file or note after you opened it, reload it before saving.
Unsaved editor changes are retained when switching between Workspace and
Notepad, and leaving an edited document prompts before discarding changes.

## Filesystem behavior

- File uploads, downloads, and ZIP construction process data in chunks. There
  is no application-defined file-size quota. Available disk space, filesystem
  permissions, and browser memory still apply; text editing loads the document
  in memory. ZIPs use temporary disk space, with ZIP64 enabled.
- ZIP downloads preserve selected workspace-relative paths and empty folders.
  Generated archives can be downloaded again or resumed while retained by the
  server. Archives older than 30 minutes are reclaimed when another archive is
  created; shutting down the server closes all archive temporary files.
- Cross-filesystem moves publish a complete copy before deleting the source.
  Failed copies remove their partial temporary data and keep the original.
  If deleting the original fails after publication, the application reports it
  and retains both copies. Ctrl+C waits for active moves to finish.
- Symlinks may be followed when their targets remain inside the workspace.
  Links outside it are listed as inaccessible; choose an appropriate wider
  workspace to access those targets. ZIP creation detects link cycles. Device
  files, sockets, and other special files are not treated as regular files.
  Windows versions of Python older than 3.8 cannot reliably resolve junctions;
  those runtimes reject paths through reparse points. Recursive deletion never
  traverses a detected symbolic link or junction.
- Host filesystem permissions are always respected. The application does not
  elevate privileges. Operations are coordinated inside one server process;
  external programs can still modify the same directories concurrently.
- Restarting the server clears workspace selections and move-job metadata,
  but never removes saved notes or workspace contents.

## Project layout

```text
app.py                       CLI entry point
frisbee_core/compat.py        Python and operating-system compatibility
frisbee_core/storage.py       Workspace, file, and notepad services
frisbee_core/jobs.py          Background moves and progress
frisbee_core/server.py        HTTP routes and streaming responses
static/index.html            Accessible application structure
static/app.css               Themes and responsive layout
static/app.js                Browser state, requests, and interactions
tests/                       Standard-library automated tests
workspace/                   Runtime local workspace (ignored by Git)
notepad/                     Runtime note files (ignored by Git)
AGENTS.md                    Maintenance guidance for coding assistants
CLAUDE.md                    Pointer to AGENTS.md for assistants that look for it
prompts/init.md              Original prompt that generated the application
LICENCE.txt                  MIT licence
version.txt                  Current application version (Semantic Versioning 2.0.0)
```

`version.txt` holds the application's current version as a single [Semantic Versioning 2.0.0](https://semver.org/) string, for example `1.0.0`. Bump it when you release a notable change.

## Tests

From `frisbee`, using either supported Python interpreter:

```text
python -m unittest discover -s tests -v
```

Tests use temporary directories and localhost ports; they never intentionally
operate on user workspaces. They cover file and note operations, binary uploads,
Unicode names, revision conflicts, ZIPs, HTTP downloads and ranges, concurrent
requests, workspace boundaries, and cross-filesystem move failure recovery.
The browser requires JavaScript, `fetch`, `XMLHttpRequest`, and standard file
input support. No JavaScript tooling is needed to run the application.

`tests/browser.mjs` is an optional developer check using an already available
Node 24 runtime and Chromium's debugging protocol, without additional packages.
It changes the test workspace, notes, and browser preferences. Run it only with
disposable application data and a separate browser profile. For example, in
three terminals on a Linux development host:

```text
python app.py --host 127.0.0.1 --port 8765 --data-dir /tmp/frisbee-browser-data
chromium --headless --remote-debugging-port=9229 --user-data-dir=/tmp/frisbee-browser-profile about:blank
node tests/browser.mjs http://127.0.0.1:8765
```

If the test server chooses a higher port because 8765 is occupied, pass its
printed URL to the browser runner instead.

The browser runner exercises notes before workspace selection, file and folder
uploads, optional thumbnails, native video playback and seeking, hidden-folder
and search filters, edits, ZIP download, rename, moves, confirmed deletion,
theme persistence, and responsive layouts. It prints the temporary location of its
screenshots and downloaded ZIP. Stop the test server and browser afterward.

Initial validation used Linux, Python 3.10, and Chromium 153. Python 2 syntax
was also parsed with a compatible grammar, and Windows junction handling has
isolated simulations. Actual execution on Python 2.7 and Windows still needs
those environments; syntax checks and simulations do not replace that testing.
