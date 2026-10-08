//! HTTP: the server and client (hand-written HTTP/1.1 on std sockets, TLS by
//! rustls), the router and its route plugins, the control panel's guard, the
//! server-sent events hub and the embedded control panel files. Never
//! touches the disk itself; every rule lives in `domain`.

pub mod assets;
pub mod client;
pub mod conn;
pub mod guard;
pub mod message;
pub mod router;
pub mod routes;
pub mod server;
pub mod sse;
pub mod tls;

use crate::http::assets::{not_found, Statics};
use crate::http::guard::Guard;
use crate::http::router::{Access, Match, Router};
use crate::http::server::{Reply, Request};
use crate::util::logger::Logger;
use serde_json::json;

/// The single request entry point: guard, route, or a control panel file.
pub struct HttpApp {
    pub router: Router,
    pub guard: Guard,
    pub statics: Statics,
    pub logger: Logger,
}

impl HttpApp {
    pub fn handle(&self, request: &mut Request<'_>) -> Reply {
        let found = self.router.find(&request.method, &request.path);
        let access = match &found {
            Match::Found(route) => route.access,
            _ => Access::Ui,
        };
        if access == Access::Ui {
            if let Some(denied) = self.guard.check_ui(request) {
                let reply = Reply::error(&denied);
                return if request.expect_continue { reply.closing() } else { reply };
            }
        }
        match found {
            Match::Found(route) => match (route.handler)(request) {
                Ok(reply) => reply,
                Err(error) => {
                    if error.status >= 500 {
                        self.logger.error(format_args!("{} {}: {}", request.method, request.path, error.message));
                    }
                    Reply::error(&error)
                }
            },
            Match::MethodMismatch => Reply::json(
                405,
                &json!({ "error": { "code": "method_not_allowed", "message": format!("{} is not allowed here.", request.method) } }),
            ),
            Match::None if request.path.starts_with("/api/") => {
                Reply::json(404, &json!({ "error": { "code": "not_found", "message": "Unknown endpoint." } }))
            }
            Match::None => {
                if request.method == "GET" || request.method == "HEAD" {
                    if let Some(reply) = self.statics.serve(&request.path) {
                        return reply;
                    }
                }
                not_found()
            }
        }
    }
}
