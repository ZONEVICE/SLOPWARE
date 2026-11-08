# Tendril

Read [`CLAUDE.md`](CLAUDE.md) in this directory before changing anything. It
is the single maintenance guide for every coding assistant working on
Tendril — Claude Code, Codex, or any other — and this file only exists so
that assistants looking for `AGENTS.md` find it.

Quick reminders that `CLAUDE.md` explains in full:

- Talk to the user in Spanish; write code, comments, documentation and
  interface text in English.
- One self-contained binary: the front end (plain HTML/CSS/ES modules,
  bundled by esbuild at build time) is embedded by `build.rs`. Build with
  `./build.sh` or `.\build.ps1`; run with nothing but the binary.
- Lowest RAM first: single-threaded tokio, lazy Monaco/xterm/languages,
  gzip assets served straight from the binary.
- Every workspace path goes through `src/services/files/jail.rs`; nothing is
  written into a workspace except the user's files; everything else lives in
  `~/.tendril/` as JSON.
- Add features as one file plus one line: `src/http/routes/` + `ROUTES`, or
  `web/src/app/features/` + `FEATURES`.
- Run `cargo test`, `npm --prefix web test` and the browser e2e test
  (`node --test tests/browser/*.test.mjs`) after any change, and look at
  screenshots (`tests/browser/shoot.mjs`) after UI changes.
