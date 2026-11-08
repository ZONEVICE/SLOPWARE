//! Primitives with no knowledge of the application.
//!
//! Nothing in this layer imports from `config`, `services` or `http`. Each
//! module is a small, self-contained tool that the upper layers combine:
//!
//! - [`clock`]: wall-clock helpers and civil-date formatting (no `chrono`).
//! - [`random`]: the OS CSPRNG, passwords and hex tokens.
//! - [`atomic`]: write-to-temp-then-rename files that never leave residue.
//! - [`jsonfile`]: typed JSON files on top of [`atomic`].
//! - [`netinfo`]: the host name and the machine's local IP addresses.
//! - [`lock`]: poison-tolerant locking.
//! - [`procinfo`]: the process's resident memory.

pub mod atomic;
pub mod clock;
pub mod jsonfile;
pub mod lock;
pub mod netinfo;
pub mod procinfo;
pub mod random;
