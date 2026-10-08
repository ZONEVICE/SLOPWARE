//! Server-sent events: how the control panel stays live.
//!
//! The browser opens `GET /api/events` once. Whenever anything it displays
//! changes, the hub sends the complete state snapshot as one `state` event.
//! Complete snapshots keep the client trivial and make a reconnect
//! self-healing: the first event after reconnecting is the truth.
//!
//! Bursts (a reconciliation reports progress for every file) are coalesced:
//! at most one snapshot per `throttle`, always ending with the latest state.
//! The bus listener only flags the hub dirty; a broadcaster thread builds the
//! snapshot, so no service lock is ever taken from inside an event.

use crate::http::server::{Reply, ReplyBody};
use crate::util::threads::Locked;
use serde_json::Value;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

type Snapshot = Box<dyn Fn() -> Value + Send + Sync>;

struct Inner {
    clients: Vec<Sender<Arc<str>>>,
    dirty: bool,
    closed: bool,
    last_sent: Option<Instant>,
}

pub struct SseHub {
    inner: Mutex<Inner>,
    signal: Condvar,
    snapshot: Snapshot,
    throttle: Duration,
    keep_alive: Duration,
}

fn frame(state: &Value) -> Arc<str> {
    Arc::from(format!("event: state\ndata: {state}\n\n"))
}

impl SseHub {
    pub fn new(snapshot: Snapshot) -> Arc<SseHub> {
        let hub = Arc::new(SseHub {
            inner: Mutex::new(Inner { clients: Vec::new(), dirty: false, closed: false, last_sent: None }),
            signal: Condvar::new(),
            snapshot,
            throttle: Duration::from_millis(120),
            keep_alive: Duration::from_secs(15),
        });
        let worker = hub.clone();
        std::thread::Builder::new()
            .name("sse".into())
            .spawn(move || worker.broadcaster())
            .expect("spawn the SSE thread");
        hub
    }

    pub fn size(&self) -> usize {
        self.inner.locked().clients.len()
    }

    /// Something changed: send a snapshot soon.
    pub fn schedule(&self) {
        let mut inner = self.inner.locked();
        if !inner.dirty {
            inner.dirty = true;
            self.signal.notify_all();
        }
    }

    fn broadcaster(&self) {
        loop {
            {
                let mut inner = self.inner.locked();
                while !inner.dirty && !inner.closed {
                    inner = self.signal.wait(inner).unwrap_or_else(std::sync::PoisonError::into_inner);
                }
                if inner.closed {
                    return;
                }
                if let Some(last) = inner.last_sent {
                    let elapsed = last.elapsed();
                    if elapsed < self.throttle {
                        drop(inner);
                        std::thread::sleep(self.throttle - elapsed);
                    }
                }
            }
            self.broadcast();
        }
    }

    /// Push a snapshot right away (used after a request changed something).
    pub fn flush(&self) {
        self.broadcast();
    }

    fn broadcast(&self) {
        {
            let mut inner = self.inner.locked();
            inner.dirty = false;
            inner.last_sent = Some(Instant::now());
            if inner.clients.is_empty() {
                return;
            }
        }
        let message = frame(&(self.snapshot)());
        self.inner.locked().clients.retain(|client| client.send(message.clone()).is_ok());
    }

    /// Take over a request and keep it open.
    pub fn handle(self: &Arc<Self>) -> Reply {
        let (sender, receiver) = channel::<Arc<str>>();
        let first = frame(&(self.snapshot)());
        self.inner.locked().clients.push(sender);
        let keep_alive = self.keep_alive;
        let run = move |writer: &mut crate::http::message::ChunkedWriter<'_>| -> std::io::Result<()> {
            writer.chunk(b"retry: 2000\n\n")?;
            writer.chunk(first.as_bytes())?;
            loop {
                match receiver.recv_timeout(keep_alive) {
                    Ok(message) => writer.chunk(message.as_bytes())?,
                    Err(RecvTimeoutError::Timeout) => writer.chunk(b": keep-alive\n\n")?,
                    Err(RecvTimeoutError::Disconnected) => return Ok(()),
                }
            }
        };
        Reply::new(
            200,
            vec![
                ("Content-Type".into(), "text/event-stream; charset=utf-8".into()),
                ("Cache-Control".into(), "no-store".into()),
            ],
            ReplyBody::Stream(Box::new(run)),
        )
    }

    pub fn close(&self) {
        let mut inner = self.inner.locked();
        inner.closed = true;
        inner.clients.clear();
        self.signal.notify_all();
    }
}
