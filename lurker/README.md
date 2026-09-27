# Lurker

> **This software was generated 100% using artificial intelligence** — specifically Claude Code + Opus 5.5, Max effort — on September 26, 2026. Generated with the `new-app` skill. The initial prompt used to create this application can be found in [`prompts/init.md`](prompts/init.md).

Lurker shows every image and video inside a directory — and inside every one
of its subfolders — in one grid that fills the browser window. Point it at
`~/Pictures`, a phone backup or a USB drive, open the address it prints on any
device of your network, and browse: filter by type, date, size, shape or video
length; switch to a folder, tree, timeline or details view; click anything to
see it full size, zoom in, play it, or download it.

It is a single Python program using nothing but the standard library. The
interface is plain HTML, CSS and JavaScript served by that program. Nothing is
installed and nothing is stored: the album lives in memory and is gone when
Lurker stops.

## Requirements

- Python 3.8 or newer. Developed and tested on Python 3.10 and 3.11 on Linux;
  the code avoids anything platform-specific, but only Linux has been tested.
- A current browser (Chrome, Edge, Firefox or Safari) on any device that can
  reach the computer running Lurker.
- Nothing else. No `pip install`, no build step, no internet connection.

## Start

From the `lurker` directory:

```bash
python3 lurker.py
```

That starts Lurker over **HTTPS on port 8080** and prints the addresses to
open, for example:

```
Lurker 1.0.0 is running over HTTPS.

  This computer   https://localhost:8080
  Other devices   https://192.168.0.246:8080

  Password        none: anyone who can reach these addresses can browse the album
  Certificate     /home/you/lurker/cert/cert.pem (new, self-signed: browsers warn once)
  Fingerprint     SHA-256 CE:29:BE:...
  Album           none yet: the first browser to connect chooses a directory
```

Open one of them. The first screen asks for the absolute path of a directory;
it checks the path as you type, completes directory names, and offers the
usual places (home, Pictures, Videos, Downloads, mounted drives). Press
**Open** and the grid appears while Lurker is still walking the tree.

Stop Lurker with <kbd>Ctrl</kbd>+<kbd>C</kbd>.

### Options

Options are plain words, as in the examples below. The dashed spellings
(`--https`, `--port 9000`, `--port=9000`, `--dir`, `--pass`) work too.

| Option | Meaning |
| --- | --- |
| `https` | Serve over HTTPS. This is the default. |
| `http` | Serve over plain HTTP instead. |
| `port <number>` | The first port to try (default `8080`). |
| `dir <path>` | Open this directory as the album right away. |
| `pass <password>` | Require this password from every browser. |
| `host <address>` | Listen on this address only (default `0.0.0.0`, every IPv4 interface). |
| `verbose` | Log every HTTP request. |
| `help`, `version` | Print the options, or the version. |

```bash
python3 lurker.py http                                  # plain HTTP on 8080
python3 lurker.py port 9000                             # HTTPS, starting at port 9000
python3 lurker.py dir /srv/photos                       # skip the directory prompt
python3 lurker.py dir ~/Pictures pass "correct horse"   # ...and ask for a password
python3 lurker.py --http --port=8000 --dir=/media/usb   # the dashed style
```

**A busy port is not an error.** If 8080 (or the port you asked for) is taken,
Lurker tries 8081, then 8082, and so on — up to 64 ports — and says which one
it got. Running `python3 lurker.py` twice simply gives you two Lurkers. `port 0`
lets the operating system pick any free port.

**HTTPS and the certificate.** Every HTTPS start generates a brand-new
self-signed certificate (RSA 2048, SHA-256, valid for this machine's name and
addresses) and replaces the previous one in `cert/` inside the application
directory (`cert/cert.pem` and `cert/key.pem`). Lurker builds the certificate
itself in pure Python, so neither `openssl` nor any package is needed. Because
it is self-signed, browsers warn about it; accept the warning once per start.
The fingerprint printed at startup lets you check you are talking to the right
machine. If you type `http://` by mistake, Lurker redirects you to `https://`.

**`dir`.** When the directory given on the command line exists and can be read,
Lurker opens it immediately and nobody sees the directory prompt. When it
cannot be used, Lurker says why in the terminal, starts anyway, and the first
browser sees the prompt with a note explaining what went wrong. A relative path
or `~` is resolved against the terminal's working directory; the browser form
itself only accepts absolute paths.

**`pass`.** With a password, the only things served before a browser unlocks
Lurker are the password page and the eye icon: every other page, script,
image, video and API call is refused. Each device must type the password
itself: the session is tied to the browser's IP address and to its browser and
operating system (its User-Agent), and it lasts until the browser is closed,
the **Lock** button is pressed, or Lurker stops. Wrong guesses are slowed down
per address (after three, each attempt waits 1, 2, 4… up to 60 seconds). Note
that other users of the *same computer* can see command-line arguments,
including the password, in the process list.

## Using Lurker

### One album, shared by everyone

A Lurker instance shows one directory at a time — the **album** — and every
browser connected to it sees the same album. When somebody opens a directory,
the others switch to it; when somebody presses **Close album** (after
confirming), everyone goes back to the directory prompt. To look at two
directories at once, start a second Lurker (it will pick the next free port).

Lurker walks the whole tree below the directory, recursively. The grid fills
in as folders are read; then Lurker reads each file's header in the background
to learn its dimensions, duration, capture date, camera and orientation, and
the tiles refine themselves. **Rescan** (the circular arrows) looks for new,
changed and deleted files without reloading anything that did not change.

### The grid and the other views

- **All** — every image and video of the album in one grid, whatever folder
  it is in. This is the default view.
- **Folders** — one directory at a time: its subfolders as cards with a cover
  and their counts, then its own files. **Include subfolders** flattens
  everything below the current folder.
- **Tree** — the directory tree beside the grid of the selected folder.
- **Timeline** — everything grouped by day, month or year, with the current
  period pinned at the top and a rail of years to jump through.
- **Details** — a sortable table: name, folder, type, size, dimensions,
  duration and date.

The toolbar filters images or videos, searches names and folder names
(ignoring case and accents), sorts (date, dates modified or created, name,
size, resolution, duration, type, folder, or shuffled), switches between
square tiles and tiles that keep each picture's proportions, and sets the tile
size. The **Filters** panel adds file type, date range (by capture date or file
dates, with presets), file size, orientation (landscape, portrait, square,
panorama), minimum resolution, video length, camera model, hidden files,
animated images only, and "only what this browser can show". Active filters
appear as chips that remove themselves with one click.

Every setting lives in the address bar (`#/grid?kind=video&sort=size…`), so
reloading, the back button and a copied link all bring back the same view.
Nothing is stored anywhere else: there are no cookies except the password
session, and nothing in the browser's storage.

### The viewer

Click a tile to open it full size. For images: zoom with the mouse wheel,
pinch, a double click (fit ↔ 100 %) or the buttons; drag to pan; rotate the
view. Videos play in the browser's own player. For both: previous and next,
a slideshow (videos play to the end before moving on), an information panel
(dimensions, dates, camera, lens, exposure, GPS position…), download, and full
screen. On phones, swipe left and right to move, down to close.

| Key | Action |
| --- | --- |
| <kbd>←</kbd> <kbd>→</kbd> | Previous / next |
| <kbd>+</kbd> <kbd>−</kbd> <kbd>0</kbd> <kbd>1</kbd> | Zoom in, out, fit, 100 % |
| <kbd>R</kbd> / <kbd>Shift</kbd>+<kbd>R</kbd> | Rotate right / left |
| <kbd>I</kbd> | Information |
| <kbd>S</kbd> | Slideshow |
| <kbd>Space</kbd> | Play / pause a video |
| <kbd>D</kbd> | Download |
| <kbd>F</kbd> | Full screen |
| <kbd>Esc</kbd> | Close |
| <kbd>/</kbd> (in the grid) | Search |

### Which files are shown

Lurker registers files by extension and shows whatever the browser can draw.

| Kind | Formats | In the browser |
| --- | --- | --- |
| Images | JPEG, PNG/APNG, GIF, WebP, AVIF, BMP, ICO, SVG | Everywhere |
| Images | HEIC/HEIF, TIFF, JPEG XL | Where the browser supports them (Safari) |
| Images | Camera RAW (DNG, CR2, NEF, ARW, ORF, RW2, RAF, …) | Through the JPEG preview the camera embedded |
| Images | Photoshop (PSD) | Placeholder and download |
| Videos | MP4/M4V, WebM | Everywhere (codec permitting) |
| Videos | MOV, MKV, 3GP, OGV | Where the browser can decode them |
| Videos | AVI, WMV, FLV, MPEG, MPEG-TS, RealMedia | Placeholder and download |

JPEG photos get their embedded EXIF thumbnail in the grid first, then the full
photo. Video tiles show a frame the browser captures itself. EXIF orientation
is honoured, and phone videos recorded upright are shown upright. `.ts` and
`.mts` files are only counted as video when their content really is an MPEG
transport stream (most `.ts` files on a developer's disk are TypeScript).
Symbolic links are not followed, and files whose names start with a dot are
shown unless you hide them in the filters.

## Privacy and security

- Lurker only reads. It never writes, moves or deletes anything in the album,
  and it stores nothing: the only file it writes is the certificate in `cert/`.
- A browser can only fetch files the scan registered, by number; no request
  ever carries a file path, so nothing outside the album can be reached.
- Without a password, anyone who can reach the address can browse the album.
  To stop other web pages from reading the album through your browser, Lurker
  then only answers to IP addresses, `localhost`, single-word names and local
  names (`.local`, `.lan`, `.home.arpa`…). With a password, any host name works.
- Files from the album are served with a sandboxing policy, so an SVG opened on
  its own cannot run scripts.

## Tests

```bash
python3 -m unittest discover -s tests -t .
```

The suite uses only the standard library's `unittest`. The browser tests drive
a real headless Chromium or Chrome over the DevTools pipe (no WebDriver, no
package); they skip themselves when no such browser is installed, or when
`LURKER_SKIP_BROWSER_TESTS=1`. `LURKER_TEST_SCREENSHOTS=/some/dir` keeps a
screenshot of each screen they visit. The tests in `test_real_media.py` also
check the readers against files written by `ffmpeg` and ImageMagick when those
are installed, and skip otherwise.

## Project layout

```
lurker.py            the command you run
server/              the Python server (standard library only)
  config.py          command-line options
  lib/               helpers: events, port walk, network names, certificates (ASN.1, RSA, X.509)
  media/             file formats and the header readers (JPEG/EXIF, PNG, MP4, Matroska, ...)
  domain/            the album, its catalog, scanning, probing, previews and passwords
  web/               HTTP server, routing, guard, files, event stream, routes/
  app.py, main.py    wiring and the startup banner
public/              the browser application (HTML, CSS, ES modules; no build step)
tests/               unittest suite and its helpers (fixtures, Chromium driver)
```

## Licence

MIT — see [`LICENCE.txt`](LICENCE.txt).
