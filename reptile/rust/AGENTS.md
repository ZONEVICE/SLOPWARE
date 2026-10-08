# Reptile (Rust)

Read [`CLAUDE.md`](CLAUDE.md) in this directory before changing anything, and
[`../CLAUDE.md`](../CLAUDE.md) before it: together they are the maintenance
guide for every coding assistant (this file only exists so that assistants
looking for `AGENTS.md` find them). In short: Spanish with the user, English in
the code; only `rustls`, `ring`, `serde_json`, `libc` and `windows-sys`; no
async runtime; the control panel is `../node/public`, embedded at build time;
the wire protocol must stay compatible with the Node.js implementation; run
`cargo test` (it includes the interoperability tests) after any change.
