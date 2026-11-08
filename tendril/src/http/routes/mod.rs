//! HTTP routes, one module per feature.
//!
//! **Extension point.** A feature is a module with
//! `pub fn register(routes: Routes) -> Routes` that adds its endpoints to
//! `routes.public` (no session needed: only the login lives there) or
//! `routes.private` (session required, counted as user activity). Adding a
//! feature is one new file plus one line in [`ROUTES`]; removing it is
//! deleting that line. Order does not matter.
//!
//! Everything that matches no route falls through to [`pages::serve`], which
//! serves the embedded front end.

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::middleware;

use super::guard;
use super::state::AppState;

pub mod auth;
pub mod files;
pub mod git;
pub mod pages;
pub mod picker;
pub mod raw;
pub mod search;
pub mod settings;
pub mod system;
pub mod terminal;

/// The two route sets features add to.
pub struct Routes {
    /// Served without a session.
    pub public: Router<AppState>,
    /// Require a session; requests count as user activity.
    pub private: Router<AppState>,
}

/// A feature's registration function.
pub type Register = fn(Routes) -> Routes;

/// Every feature, registered in this order.
pub const ROUTES: &[Register] = &[
    auth::register,
    picker::register,
    files::register,
    raw::register,
    search::register,
    terminal::register,
    git::register,
    settings::register,
    system::register,
];

/// Default body limit for JSON endpoints; uploads and saves override it.
pub const JSON_LIMIT: usize = 256 * 1024;

/// Builds the complete router: features, the page fallback and the guards.
pub fn build(state: AppState) -> Router {
    let mut routes = Routes { public: Router::new(), private: Router::new() };
    for register in ROUTES {
        routes = register(routes);
    }
    let private = routes.private.route_layer(middleware::from_fn_with_state(state.clone(), guard::require_session));
    Router::new()
        .merge(routes.public)
        .merge(private)
        .fallback(pages::serve)
        .layer(DefaultBodyLimit::max(JSON_LIMIT))
        .layer(middleware::from_fn_with_state(state.clone(), guard::guard))
        .with_state(state)
}
