//! The rules of the application. Nothing here knows about HTTP.
//!
//! - [`events`]: the publish/subscribe seam (see its module docs).
//! - [`logger`]: JSON Lines logs.
//! - [`auth`]: password, sessions, per-IP blacklist.
//! - [`activity`]: user activity and the idle timeout.
//! - [`shutdown`]: the process-wide stop signal.
//! - [`files`]: the workspace file system, confinement first.
//! - [`workspaces`]: which workspaces each session opened, recent folders.
//! - [`terminals`]: pseudo-terminals for the integrated terminal.
//! - [`git`]: git through the host's `git` program.
//!
//! Dependencies: `core` and `config` only.

pub mod activity;
pub mod auth;
pub mod events;
pub mod files;
pub mod git;
pub mod logger;
pub mod shutdown;
pub mod terminals;
pub mod workspaces;
