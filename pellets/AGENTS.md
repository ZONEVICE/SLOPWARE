# Pellets

Read [`CLAUDE.md`](CLAUDE.md) in this directory before changing anything. It is
the single maintenance guide for every coding assistant working on Pellets —
Claude Code, Codex, or any other — and this file only exists so that assistants
looking for `AGENTS.md` find it.

Quick reminders that `CLAUDE.md` explains in full:

- Talk to the user in Spanish; write code, comments, and UI text in English.
- `ws` is the only npm dependency allowed, in any layer, including tests.
  The front end is plain HTML, CSS and ES modules with no build step.
- `npm start` must start the whole application in a single Node process.
- Chat state lives in memory only. `uploads/` is the sole exception, and it
  holds raw file bytes, never chat data.
- Messages are append-only: no edit, no delete, anywhere in the stack.
- Business rules belong in `src/domain/`, so REST and WebSocket share them.
- Run `npm test` (194 tests) after any change under `src/` or `public/`.
