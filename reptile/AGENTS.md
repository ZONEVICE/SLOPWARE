# Reptile

Read [`CLAUDE.md`](CLAUDE.md) in this directory before changing anything. It
is the single maintenance guide for every coding assistant working on Reptile —
Claude Code, Codex, or any other — and this file only exists so that
assistants looking for `AGENTS.md` find it.

Quick reminders that `CLAUDE.md` explains in full:

- Talk to the user in Spanish; write code, comments, and UI text in English.
- `chokidar` is the only npm dependency allowed, in any layer, including
  tests. The front end is plain HTML, CSS and ES modules with no build step.
- Nothing about Reptile is persisted between runs; `--https` makes a new
  certificate in `cert/` on every start.
- Unchecked items never leave the host and are never modified by the peer.
- Business rules belong in `src/domain/`; the HTTP layer only translates.
- Run `npm test` (219 tests, ~16 s) after any change under `src/` or `public/`.
