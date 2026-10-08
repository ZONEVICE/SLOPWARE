//! Tiny route table.
//!
//! MODULARITY: routes are registered by plugins (`http::routes::PLUGINS`), each
//! a function `(router, deps)`. Adding an endpoint group means writing one file
//! and adding one line to that list.

use crate::domain::errors::AppResult;
use crate::http::server::{Reply, Request};

/// Who may call a route; see `http::guard`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// The control panel (the default): guarded.
    Ui,
    /// Another instance; the handler checks the PIN or the token.
    Peer,
    /// Anyone (only `GET /api/ping`).
    Public,
}

pub type RouteHandler = Box<dyn Fn(&mut Request<'_>) -> AppResult<Reply> + Send + Sync>;

pub struct Route {
    pub method: &'static str,
    pub path: &'static str,
    pub access: Access,
    pub handler: RouteHandler,
}

pub enum Match<'a> {
    Found(&'a Route),
    MethodMismatch,
    None,
}

#[derive(Default)]
pub struct Router {
    routes: Vec<Route>,
}

impl Router {
    pub fn new() -> Router {
        Router::default()
    }

    pub fn add(
        &mut self,
        method: &'static str,
        path: &'static str,
        access: Access,
        handler: impl Fn(&mut Request<'_>) -> AppResult<Reply> + Send + Sync + 'static,
    ) -> &mut Router {
        self.routes.push(Route { method, path, access, handler: Box::new(handler) });
        self
    }

    /// Find the route for a request. HEAD is served by GET routes; a trailing
    /// slash is tolerated.
    pub fn find(&self, method: &str, path: &str) -> Match<'_> {
        let path = if path.len() > 1 { path.strip_suffix('/').unwrap_or(path) } else { path };
        let mut mismatch = false;
        for route in &self.routes {
            if route.path != path {
                continue;
            }
            if route.method == method || (method == "HEAD" && route.method == "GET") {
                return Match::Found(route);
            }
            mismatch = true;
        }
        if mismatch {
            Match::MethodMismatch
        } else {
            Match::None
        }
    }
}
