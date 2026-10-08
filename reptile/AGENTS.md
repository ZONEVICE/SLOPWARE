# Reptile

Read [`CLAUDE.md`](CLAUDE.md) in this directory before changing anything. It
is the single maintenance guide for every coding assistant working on Reptile —
Claude Code, Codex, or any other — and this file only exists so that
assistants looking for `AGENTS.md` find it. Each implementation has its own
guide next to its code: [`node/CLAUDE.md`](node/CLAUDE.md) and
[`rust/CLAUDE.md`](rust/CLAUDE.md).

Quick reminders that `CLAUDE.md` explains in full:

- Talk to the user in Spanish; write code, comments, and UI text in English.
- Two implementations (Node.js in `node/`, Rust in `rust/`) of one product:
  they must stay wire-compatible, share one control panel (`node/public`) and
  one version (`version.txt`, matched by `rust/Cargo.toml`).
- Node.js has no npm dependency at all; Rust uses only `rustls`, `ring`,
  `serde_json`, `libc` and `windows-sys`.
- Nothing about Reptile is persisted between runs; `--https` makes a new
  certificate on every start.
- Unchecked items never leave the host and are never modified by the peer.
- Business rules belong in `domain/`, in both implementations.
- Run `npm test` in `node/` and `cargo test` in `rust/` (it includes the
  interoperability tests) after any change.
