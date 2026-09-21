---
name: new-app
description: Conventions every new application in the SLOPWARE repository must follow - Spanish in the chat and English in the repository, the standard-library-only rule, modular architecture with real seams, automatic port fallback for web apps, LICENCE.txt, version.txt, prompts/init.md, the README AI-generation preamble, the CLAUDE.md/AGENTS.md handoff file, and the row in the root README. Use this skill whenever the user asks to create, build, scaffold or generate a new application, server, tool, site, game or utility in this repository, including when they only describe what it should do and never say the word "app". Read it before writing the first file, not after.
---

# Adding a new application to SLOPWARE

> **Reading this as a non-Claude agent (Codex or another assistant)?**
> This file is a Claude Code "skill", which is just a Markdown document with a
> YAML header. Ignore the header and read the body. Nothing here depends on
> Claude Code, on tool calls, or on any runtime: it is a checklist of this
> repository's conventions, and it applies to you exactly as written.

## When this applies

Any time a new top-level directory is added to this repository to hold a new
program. The trigger is the intent, not the wording: "make me a thing that
tracks my reading list" is the same request as "create a new app".

It does **not** apply to changes inside an application that already exists.
For those, read that application's own `CLAUDE.md` or `AGENTS.md`.

## Language: Spanish in the chat, English in the repository

Talk to the developer in **Spanish**. Everything that ends up committed is
written in **English**: source code and identifiers, comments, documentation,
commit messages, and every string the interface shows a user.

The split is deliberate. The conversation should be comfortable for the person
you are working with, while the artifact stays readable to anyone who finds the
repository later - including the next assistant that opens it with no context.
What to avoid is mixing the two: a Spanish comment inside English code, or an
English progress report in the chat.

Restate this rule in the app's own `CLAUDE.md` / `AGENTS.md`, because an
assistant that starts from that file and never reads this one still has to
follow it.

## Why these conventions exist

Every app here is self-contained: no shared build system, no shared
dependencies, no cross-app imports. Someone should be able to copy one
directory out of this repository and have it still work. The rules below all
serve that, plus one more goal - the repository is an honest record of what AI
assistants can build end to end, so each app documents how it was made.

## The checklist

| Path | Required | Notes |
| --- | --- | --- |
| `<app>/README.md` | always | Starts with the AI-generation preamble |
| `<app>/LICENCE.txt` | always | Byte-identical to the repository root's |
| `<app>/version.txt` | always | `1.0.0`, no trailing newline |
| `<app>/prompts/init.md` | always | The prompt that produced the app |
| `<app>/CLAUDE.md` or `<app>/AGENTS.md` | always, written last | Named after the tool that built it |
| `<app>/.gitignore` | when it has runtime artifacts | Uploads, caches, generated certs |
| Root `README.md` | always | One new row in the Applications table |

Existing apps to copy conventions from: `frisbee/` (standard-library Python),
`guanaco/` (browser-only JavaScript), `pellets/` (Node.js).

---

## 1. Standard library only

**Default to zero third-party dependencies.** Build the app with nothing but the
standard library of whatever language was asked for. No npm packages, no pip
installs, no frameworks, no CSS toolkits, no CDN links, no build step, no
transpiler.

Add a dependency only when the developer names one explicitly. `pellets/` is the
precedent: its prompt said to use `ws`, so it uses `ws` and nothing else - not
even a test framework or a linter.

This is not asceticism. It is what keeps every app runnable years from now with
one command and no lockfile archaeology, and it is the constraint that makes the
repository interesting in the first place.

The rule bites hardest on web apps, which is where the temptation is strongest.
Some things you will have to write by hand instead of installing:

- a router, a static file server, and MIME type lookup
- `multipart/form-data` parsing, if the app accepts file uploads
- a self-signed certificate, if the app serves HTTPS
- the whole front end, as plain HTML, CSS and ES modules served as they are

If a task genuinely cannot be done without a dependency, say so and ask, rather
than installing one quietly.

## 2. Modular by design

Build the app so features can be attached and detached like Lego bricks, and so
a new one can be dropped **into the middle** of the system rather than only
bolted onto the end. That is the real test: appending is easy in any codebase,
while inserting a step between two existing ones is what reveals whether the
seams are real.

Three patterns carry most of the weight, and they compose:

1. **Dependencies flow one way.** Configuration, then state, then the rules,
   then the things that talk to the outside world (HTTP, a socket, a CLI, the
   screen). A lower layer never imports an upper one. This is what lets you add
   a second way in - a REST route beside a WebSocket frame - without touching
   the rules underneath.

2. **Put a publish/subscribe seam between the rules and the outside.** The part
   that knows the business rules announces what happened; whatever cares
   subscribes. Because it never calls the transport directly, a new feature can
   listen to existing events without a single existing file importing it. In
   `pellets/` this is `src/lib/events.js`, and it is the reason a room created
   over REST reaches every open WebSocket without the REST route knowing sockets
   exist.

3. **Register features through an index instead of hard-wiring them.** Each
   feature is one file exporting a small `register(...)` function, and one index
   file lists them. See `pellets/src/http/routes/index.js` and
   `pellets/src/realtime/handlers/index.js`. Adding an endpoint or a message
   type is then one new file plus one line, and removing it is deleting that
   line.

**The litmus test:** if adding the next feature means editing five files in
different layers, the seams are in the wrong place. One new file plus one line
in an index is the shape to aim for.

**And the counterweight:** seams are not the same as indirection. Do not build a
plugin system for a script that will never have plugins, or wrap one function in
three layers of abstraction because it might grow. Modularity here means clear
boundaries and one obvious place for each kind of change - not more machinery.
A small app earns its modularity by keeping its layers honest, not by adding
registries it does not need.

Whatever structure you land on, name the extension points explicitly in the
app's `CLAUDE.md` / `AGENTS.md`, with the sentence that says where to drop a
file to add a feature. A seam nobody can find is not a seam.

## 3. Web apps: a busy port is not an error

Any app that listens on a port must **find a free one instead of refusing to
start**. Start at the port it wants - 8080 by default in this repository, or
whatever the user passed - and if it is taken, try the next one, then the next,
until a bind succeeds. Then print the port it actually got.

The reason is mundane and constant: the developer already has an instance of
this or another app running, and a crash on startup with `EADDRINUSE` wastes
their time for no reason. Running the start command twice should simply give
them two servers.

This applies to an explicitly requested port too. `--port 8080` means "start
here", not "this port or nothing".

Four details that are easy to get wrong:

1. **Only retry on "address already in use".** A permission error on a
   privileged port, or an address that does not exist on this machine, is a real
   configuration problem. Incrementing the port hides it behind dozens of
   pointless attempts and a misleading final error.
2. **Pass port 0 through untouched.** It already means "any free port" and test
   suites rely on it.
3. **Bound the walk** (64 attempts is plenty) and, when it runs out, say which
   range was searched and how to pick a different port.
4. **Report the real port.** The bind function returns it; the startup banner
   and any printed URL must use that value, not the one that was requested.

Python, using only the standard library:

```python
import errno
from http.server import ThreadingHTTPServer

def serve(handler, host="0.0.0.0", preferred=8080, attempts=64):
    """Bind the first free port at or after `preferred`."""
    for port in range(preferred, preferred + attempts):
        try:
            return ThreadingHTTPServer((host, port), handler)
        except OSError as exc:
            if exc.errno != errno.EADDRINUSE:
                raise  # permissions, bad address: walking ports will not help
            if port == preferred:
                print("port %d is in use, looking for a free one" % preferred)
    raise SystemExit(
        "No free port between %d and %d." % (preferred, preferred + attempts - 1)
    )
```

Node.js, same idea. A failed bind leaves the server object usable, so retry on
the same instance - building a new one would lose any listener already attached
to it, such as a WebSocket `upgrade` handler:

```js
const bindOnce = (server, port, host) =>
  new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

async function listen(server, host, preferred = 8080, attempts = 64) {
  for (let port = preferred; port < preferred + attempts; port += 1) {
    try {
      return await bindOnce(server, port, host);
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`No free port between ${preferred} and ${preferred + attempts - 1}.`);
}
```

A complete, tested implementation is in `pellets/src/app.js` (`bind` and
`listen`), with its tests in `pellets/tests/startup.test.js`.

---

## 4. The required files

### `README.md`

The very first thing after the title is the AI-generation preamble. Match the
existing apps exactly in shape; only the slots change:

```markdown
# <AppName>

> **This software was generated 100% using artificial intelligence** — specifically <TOOL + MODEL>, <EFFORT> effort — on <Month D, YYYY>. <SKILLS SENTENCE> The initial prompt used to create this application can be found in [`prompts/init.md`](prompts/init.md). Post-creation adjustments draw on <TOOL + MODEL>, <EFFORT> effort.
```

- `<TOOL + MODEL>` and `<EFFORT>`: whatever you are actually running as. Use the
  names the root README uses - `Claude Code + Opus 5` with `Max` effort, or
  `Codex + GPT-6 Astra` with `Ultra` effort. If you cannot tell what you are,
  assume Claude Code + Opus 5, Max effort.
- `<Month D, YYYY>`: the date the app was generated, e.g. `September 21, 2026`.
- `<SKILLS SENTENCE>`: existing apps say `No skills were used during
  generation.` That sentence stops being true once you use this one, so write
  what actually happened instead, such as "Generated with the new-app skill."
  The preamble is a record of how the app was made, not boilerplate to copy.

After the preamble, document the app for a person: what it is, requirements,
how to install and run it, how to configure it, how to run its tests, and its
licence. Write it in English.

### `LICENCE.txt`

Copy it from the repository root so it stays byte-identical:

```bash
cp LICENCE.txt <app>/LICENCE.txt
```

It is MIT, `Copyright 2026 ZONEVICE`. Do not retype it, do not reformat it, and
do not add per-file licence headers anywhere in the source.

### `version.txt`

The single string `1.0.0` with no trailing newline, matching the other apps:

```bash
printf '1.0.0' > <app>/version.txt
```

### `prompts/init.md`

The prompt that produced the app, kept verbatim as history rather than as a
specification to re-execute. When later prompts change the app materially,
append them under a short heading - `frisbee/`, `guanaco/` and `pellets/` all do
this. Say at the top that the live maintenance guide is `CLAUDE.md` /
`AGENTS.md`, so nobody mistakes the prompt for current truth.

### `CLAUDE.md` or `AGENTS.md`

**Write this last**, once the app is finished and its tests pass, because it
documents what was actually built rather than what was planned.

Name the full guide after the tool that built the app: `CLAUDE.md` if you are
Claude Code, `AGENTS.md` if you are Codex. Then add a short file under the other
name - a paragraph pointing at the real guide, plus the handful of constraints
that must not be missed - so an assistant that looks for either name finds its
way. `frisbee/` and `pellets/` both do this.

The guide is for an assistant arriving with no conversation context. Useful
content, roughly in this order:

- the hard constraints, and what breaks if each is ignored
- the architecture: the layers, which direction dependencies flow, and where a
  new rule belongs
- the extension points - where to drop a file to add a feature
- any wire protocol or file format the app defines
- **the bugs that cost you time**, each with its fix, so nobody reintroduces
  them; this ages better than anything else in the document
- how to run the tests, and what each test file covers
- code conventions, and the deliberate non-goals

### `.gitignore`

Only if the app writes runtime artifacts: dependency directories, uploads,
caches, generated certificates, logs. Keep the app's own lockfile tracked if it
has a dependency.

---

## 5. Register the app in the root README

Add one row to the Applications table in the repository's root `README.md`,
keeping the existing alphabetical-by-directory order:

```markdown
| [`<app>/`](<app>/) | One sentence describing what it does. |
```

The description should say what the app is and what is distinctive about it, in
the voice of the existing rows.

## 6. Tests

Write tests, and use the language's built-in test runner so the
standard-library rule holds: `unittest` for Python, `node --test` for Node.js.

Cover the behaviour the user asked for, not just the helpers - that is what
makes the suite the executable form of the specification. Include the port walk
if the app listens on one. Run the whole suite and make it pass before writing
the handoff guide.

## 7. Commit

One commit per new app. The format is set by
[`guanaco/prompts/commit-gen.md`](../../../guanaco/prompts/commit-gen.md) and is
visible in `git log`: a short English title of 10 words or fewer, then a bullet
per file.

```
Add <AppName>: <short description>

- .gitignore > Added file
- README.md > Added file
- src/main.py > Added file
- Repository README.md > Added <AppName> to the applications table
```

Paths are relative to the app directory, sorted with `LC_ALL=C sort` (dotfiles,
then uppercase, then lowercase). The last bullet is written out in words because
it refers to the root README rather than the app's own. Commit only; do not push
unless asked.

---

## Before calling it done

- The app runs with one command, from a clean checkout, with no install step
  beyond the one documented in its README.
- Starting it twice in a row works, and the second instance says which port it
  moved to.
- No dependency was added that the developer did not ask for by name.
- Adding the next feature would mean writing one file and registering it,
  rather than editing several files across layers.
- Everything committed is in English, and the conversation stayed in Spanish.
- `README.md`, `LICENCE.txt`, `version.txt`, `prompts/init.md` and the handoff
  guide all exist, and the root README lists the app.
- The whole test suite passes, and you have said so with the actual numbers.
