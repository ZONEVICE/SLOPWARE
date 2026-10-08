//! The peer API: what a syncing instance (Rust or Node.js) calls on the
//! instance that hosts.
//!
//! Everything except `connect` requires `Authorization: Bearer <token>`. The
//! rules live in `domain::hosting`; this file only speaks HTTP.

use crate::domain::errors::AppError;
use crate::domain::hosting::{HostingService, Share, Sink};
use crate::domain::protocol::{headers, paths};
use crate::fs::entry::State;
use crate::http::router::{Access, Router};
use crate::http::routes::Deps;
use crate::http::server::{Reply, ReplyBody, Request};
use serde_json::{json, Value};
use std::sync::Arc;

/// A stream attached to its session; dropping it detaches it.
struct Attached {
    hosting: Arc<HostingService>,
    share: Arc<Share>,
    sink: Arc<Sink>,
}

impl Drop for Attached {
    fn drop(&mut self) {
        self.hosting.detach_stream(&self.share, &self.sink);
    }
}

/// The bearer token of a request, or "".
fn bearer(request: &Request<'_>) -> String {
    request
        .header("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|token| token.trim().to_string())
        .unwrap_or_default()
}

/// A number from a header, as JavaScript's `Number(x)` reads it (NaN when
/// absent or empty).
fn number_header(request: &Request<'_>, name: &str) -> f64 {
    match request.header(name).map(str::trim) {
        None | Some("") => f64::NAN,
        Some(text) => text.parse::<f64>().unwrap_or(f64::NAN),
    }
}

pub fn register(router: &mut Router, deps: &Arc<Deps>) {
    let connect = deps.clone();
    router.add("POST", paths::CONNECT, Access::Peer, move |request| {
        let body = request.read_json(64 * 1024)?;
        let remote = request.remote.clone();
        Ok(Reply::json(
            200,
            &connect.hosting.connect(body.get("pin"), body.get("protocol"), body.get("peer"), &remote)?,
        ))
    });

    let stream = deps.clone();
    router.add("GET", paths::STREAM, Access::Peer, move |request| {
        let token = bearer(request);
        stream.hosting.verify(&token)?;
        let (sink, lines) = Sink::new();
        let share = stream.hosting.attach_stream(&token, sink.clone())?;
        // Detaches when the stream ends, and also when it never starts (the
        // client left before the response head could be written).
        let attached = Attached { hosting: stream.hosting.clone(), share, sink };
        let run = move |writer: &mut crate::http::message::ChunkedWriter<'_>| -> std::io::Result<()> {
            let _attached = attached;
            for line in lines.iter() {
                writer.chunk(line.as_bytes())?;
            }
            Ok(())
        };
        Ok(Reply::new(
            200,
            vec![
                ("Content-Type".into(), "application/x-ndjson; charset=utf-8".into()),
                ("Cache-Control".into(), "no-store".into()),
            ],
            ReplyBody::Stream(Box::new(run)),
        ))
    });

    let manifest = deps.clone();
    router.add("GET", paths::MANIFEST, Access::Peer, move |request| {
        Ok(Reply::json(200, &manifest.hosting.manifest(&bearer(request))?))
    });

    let hashes = deps.clone();
    router.add("POST", paths::HASHES, Access::Peer, move |request| {
        let body = request.read_json(16 * 1024 * 1024)?;
        Ok(Reply::json(200, &hashes.hosting.hashes(&bearer(request), body.get("paths"))?))
    });

    let download = deps.clone();
    router.add("GET", paths::FILE, Access::Peer, move |request| {
        let path = request.query_param("path").map(Value::String);
        let file = download.hosting.open_file(&bearer(request), path.as_ref())?;
        let size = file.state.size;
        let body = if size == 0 {
            ReplyBody::Empty
        } else {
            let handle = std::fs::File::open(&file.absolute)
                .map_err(|_| AppError::not_found(format!("\"{}\" is not a file on the host.", file.path)))?;
            ReplyBody::File { file: handle, length: size }
        };
        let mut reply = Reply::new(
            200,
            vec![
                ("Content-Type".into(), "application/octet-stream".into()),
                ("Cache-Control".into(), "no-store".into()),
                (headers::SIZE.into(), size.to_string()),
                (headers::MTIME.into(), file.state.mtime_ms.to_string()),
            ],
            body,
        );
        let hosting = download.hosting.clone();
        reply.on_complete = Some(Box::new(move || hosting.file_sent(&file)));
        Ok(reply)
    });

    let upload = deps.clone();
    router.add("PUT", paths::FILE, Access::Peer, move |request| {
        let size = number_header(request, headers::SIZE);
        let mtime_ms = number_header(request, headers::MTIME);
        let base_size = number_header(request, headers::BASE_SIZE);
        let base_mtime = number_header(request, headers::BASE_MTIME);
        let base = (base_size.is_finite() && base_mtime.is_finite())
            .then(|| State::file(base_size.max(0.0) as u64, base_mtime as i64));
        let declared = number_header(request, "content-length");
        if declared.is_finite() && size.is_finite() && declared != size {
            return Err(AppError::bad_request("Content-Length and the declared file size differ.", "size_mismatch"));
        }
        // Decide before reading a single byte. With `Expect: 100-continue` a
        // refused upload never sends its body at all.
        let path = request.query_param("path").map(Value::String);
        let prepared = upload.hosting.prepare_upload(&bearer(request), path.as_ref(), size, mtime_ms, base)?;
        if prepared.unchanged {
            return Ok(Reply::json(200, &json!({ "ok": true, "unchanged": true })));
        }
        let result = upload.hosting.receive_file(prepared, request, size as u64, mtime_ms as i64)?;
        Ok(Reply::json(200, &result))
    });

    let ops = deps.clone();
    router.add("POST", paths::OPS, Access::Peer, move |request| {
        let body = request.read_json(64 * 1024 * 1024)?;
        Ok(Reply::json(200, &ops.hosting.apply_ops(&bearer(request), body.get("ops"))?))
    });

    let heartbeat = deps.clone();
    router.add("POST", paths::HEARTBEAT, Access::Peer, move |request| {
        let body = request.read_json(64 * 1024)?;
        Ok(Reply::json(200, &heartbeat.hosting.heartbeat(&bearer(request), &body)?))
    });

    let disconnect = deps.clone();
    router.add("POST", paths::DISCONNECT, Access::Peer, move |request| {
        request.read_json(1024)?;
        Ok(Reply::json(200, &disconnect.hosting.disconnect(&bearer(request))?))
    });
}
