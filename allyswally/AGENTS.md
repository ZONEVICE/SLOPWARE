# AllySwally

Read [`CLAUDE.md`](CLAUDE.md) in this directory before changing anything. It is
the single maintenance guide for every coding assistant working on AllySwally —
Claude Code, Codex, or any other — and this file only exists so that assistants
looking for `AGENTS.md` find it.

Quick reminders that `CLAUDE.md` explains in full:

- Talk to the user in Spanish; write code, comments, documentation and
  interface text in English.
- Rust standard library only, plus hand-declared Win32 FFI (`src/win/ffi.rs`).
  No crates at all — `Cargo.toml` has no `[dependencies]`. The HTTP/1.1 parser,
  the WebSocket (RFC 6455), JSON, SHA-1 and Base64 are all hand-written.
- The front end is plain HTML/CSS/ES modules embedded in the binary; one
  self-contained `.exe` is the whole product (static CRT, system DLLs only).
- `panic = "unwind"`, never `"abort"`: client-thread panics are caught per
  connection so the server never dies.
- HTTP only; nothing but the static assets and `POST /api/pin` is served before
  the PIN. Logs never record typed text or clipboard content.
- Rules live in `src/api/`; `src/http` and `src/ws` only speak the wire.
- Port 8787 by default; a busy port walks upward. Run `cargo test` (83 tests)
  after any change.
