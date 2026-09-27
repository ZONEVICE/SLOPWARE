# Lurker

Read [`CLAUDE.md`](CLAUDE.md) in this directory before changing anything. It is
the single maintenance guide for every coding assistant working on Lurker —
Claude Code, Codex, or any other — and this file only exists so that
assistants looking for `AGENTS.md` find it.

Quick reminders that `CLAUDE.md` explains in full:

- Talk to the user in Spanish; write code, comments, documentation and
  interface text in English.
- Python standard library only, in every layer including the tests. The front
  end is plain HTML, CSS and ES modules with no build step.
- Nothing is persisted, on the server or in the browser; `https` (the
  default) mints a new certificate in `cert/` on every start.
- A busy port moves to the next one; options are bare words (`port 9000`).
- With `pass`, nothing but the login page and the icon is served before
  unlocking. Lurker never writes into the album.
- Rules belong in `server/domain/`; the web layer only translates.
- Run `python3 -m unittest discover -s tests -t .` (182 tests, ~50 s) after
  any change.
