//! The filesystem side: entry states, the index, walking, hashing, path
//! validation, safe mutations and change detection. No network, no rules.

pub mod entry;
pub mod hash;
pub mod index;
pub mod mutate;
pub mod ops;
pub mod os_watch;
pub mod path_check;
pub mod walk;
pub mod watcher;
