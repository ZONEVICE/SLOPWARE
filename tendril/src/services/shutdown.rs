//! A one-shot, process-wide stop signal.
//!
//! Anything may request a shutdown (the idle watchdog, the "Stop Tendril"
//! button, Ctrl+C); the first reason wins. The accept loop and the composition
//! root wait on it, then terminals are killed and the logs flushed before the
//! process exits.

use tokio::sync::watch;

/// The stop signal.
pub struct Shutdown {
    tx: watch::Sender<Option<String>>,
}

impl Default for Shutdown {
    fn default() -> Self {
        Shutdown::new()
    }
}

impl Shutdown {
    /// A signal that has not fired.
    pub fn new() -> Shutdown {
        Shutdown { tx: watch::channel(None).0 }
    }

    /// Requests the shutdown. Later calls keep the first reason.
    pub fn trigger(&self, reason: impl Into<String>) {
        let reason = reason.into();
        self.tx.send_if_modified(|current| {
            if current.is_none() {
                *current = Some(reason);
                true
            } else {
                false
            }
        });
    }

    /// The reason, once triggered.
    pub fn reason(&self) -> Option<String> {
        self.tx.borrow().clone()
    }

    /// A receiver to `await` the signal on.
    pub fn subscribe(&self) -> watch::Receiver<Option<String>> {
        self.tx.subscribe()
    }

    /// Resolves once the signal fired, with its reason.
    pub async fn wait(&self) -> String {
        let mut rx = self.subscribe();
        loop {
            if let Some(reason) = rx.borrow_and_update().clone() {
                return reason;
            }
            if rx.changed().await.is_err() {
                return "shutdown".into();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_reason_wins() {
        let shutdown = Shutdown::new();
        assert_eq!(shutdown.reason(), None);
        shutdown.trigger("idle");
        shutdown.trigger("button");
        assert_eq!(shutdown.reason().as_deref(), Some("idle"));
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        assert_eq!(rt.block_on(shutdown.wait()), "idle");
    }
}
