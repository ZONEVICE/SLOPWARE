//! The publish/subscribe seam between the rules and the WebSocket transport.
//!
//! Domain code announces what happened — "the MASKED files changed", "the PIN
//! was regenerated, kick everyone" — by calling the [`Hub`], and never touches
//! a socket. Each live WebSocket connection registers a channel; the hub fans
//! a message out to all of them (or one). This is why a file edited on disk can
//! refresh the shortcut band in every open browser without the file-watcher
//! knowing that sockets exist.

use std::sync::mpsc::Sender;
use std::sync::Mutex;

/// A message queued for a client's writer thread. All socket writes go through
/// that one thread, so a server-side pong is queued here rather than written
/// from the reader thread.
#[derive(Clone, Debug)]
pub enum Outgoing {
    Text(String),
    Binary(Vec<u8>),
    Pong(Vec<u8>),
    Close,
}

struct Inner {
    next_id: u64,
    clients: Vec<(u64, Sender<Outgoing>)>,
}

pub struct Hub {
    inner: Mutex<Inner>,
}

impl Hub {
    pub fn new() -> Hub {
        Hub {
            inner: Mutex::new(Inner {
                next_id: 1,
                clients: Vec::new(),
            }),
        }
    }

    /// Register a client's outgoing channel, returning its id.
    pub fn register(&self, tx: Sender<Outgoing>) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        let id = inner.next_id;
        inner.next_id += 1;
        inner.clients.push((id, tx));
        id
    }

    /// Drop a client (its writer thread has ended).
    pub fn unregister(&self, id: u64) {
        let mut inner = self.inner.lock().unwrap();
        inner.clients.retain(|(cid, _)| *cid != id);
    }

    /// Send to every client. Dead channels are pruned.
    pub fn broadcast(&self, msg: Outgoing) {
        let mut inner = self.inner.lock().unwrap();
        inner
            .clients
            .retain(|(_, tx)| tx.send(msg.clone()).is_ok());
    }

    /// Send to one client by id.
    pub fn send_to(&self, id: u64, msg: Outgoing) {
        let inner = self.inner.lock().unwrap();
        if let Some((_, tx)) = inner.clients.iter().find(|(cid, _)| *cid == id) {
            let _ = tx.send(msg);
        }
    }

    /// Broadcast a shorthand text event like `{"type":"...", ...}`.
    pub fn broadcast_text(&self, text: String) {
        self.broadcast(Outgoing::Text(text));
    }

    /// Ask every client to close (used when the PIN is regenerated or the
    /// server is stopping).
    pub fn kick_all(&self) {
        self.broadcast(Outgoing::Close);
    }

    pub fn client_count(&self) -> usize {
        self.inner.lock().unwrap().clients.len()
    }
}

impl Default for Hub {
    fn default() -> Self {
        Hub::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    #[test]
    fn broadcast_reaches_all_clients() {
        let hub = Hub::new();
        let (tx1, rx1) = channel();
        let (tx2, rx2) = channel();
        hub.register(tx1);
        hub.register(tx2);
        hub.broadcast(Outgoing::Text("hi".into()));
        assert!(matches!(rx1.recv().unwrap(), Outgoing::Text(t) if t == "hi"));
        assert!(matches!(rx2.recv().unwrap(), Outgoing::Text(t) if t == "hi"));
    }

    #[test]
    fn send_to_targets_one() {
        let hub = Hub::new();
        let (tx1, rx1) = channel();
        let (tx2, rx2) = channel();
        let id1 = hub.register(tx1);
        hub.register(tx2);
        hub.send_to(id1, Outgoing::Text("only1".into()));
        assert!(rx1.try_recv().is_ok());
        assert!(rx2.try_recv().is_err());
    }

    #[test]
    fn unregister_removes_client() {
        let hub = Hub::new();
        let (tx, _rx) = channel();
        let id = hub.register(tx);
        assert_eq!(hub.client_count(), 1);
        hub.unregister(id);
        assert_eq!(hub.client_count(), 0);
    }

    #[test]
    fn dead_channel_is_pruned_on_broadcast() {
        let hub = Hub::new();
        let (tx, rx) = channel();
        hub.register(tx);
        drop(rx); // receiver gone; next broadcast should prune it
        hub.broadcast(Outgoing::Text("x".into()));
        assert_eq!(hub.client_count(), 0);
    }
}
