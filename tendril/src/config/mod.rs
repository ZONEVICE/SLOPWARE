//! Configuration: where Tendril keeps its data, what the user configured in
//! `settings.json`, and what was passed on the command line.
//!
//! Depends only on [`crate::core`].

pub mod cli;
pub mod paths;
pub mod settings;
