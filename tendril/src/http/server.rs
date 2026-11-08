//! The accept loop.
//!
//! Owning the loop (instead of `axum::serve`) gives Tendril what a server
//! exposed on `0.0.0.0` needs:
//!
//! - a cap on concurrent connections (each one costs buffers), with excess
//!   connections closed at once;
//! - a TLS handshake timeout, so half-open connections cannot pile up;
//! - a header read timeout (slowloris);
//! - the peer address attached to every request ([`PeerIp`]), which the
//!   blacklist and the logs rely on;
//! - HTTP/1.1 only, with upgrades for the terminal WebSocket.

use std::convert::Infallible;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::{Semaphore, watch};
use tokio_rustls::TlsAcceptor;
use tower::ServiceExt;

use crate::core::netinfo;

/// Simultaneous connections at most.
pub const MAX_CONNECTIONS: usize = 128;
/// Time allowed for a TLS handshake.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Time allowed to receive a request's headers.
pub const HEADER_TIMEOUT: Duration = Duration::from_secs(30);

/// The client's address, attached to every request as an extension.
#[derive(Debug, Clone, Copy)]
pub struct PeerIp(pub IpAddr);

/// Serves `router` on `listener` until `stop` fires.
pub async fn serve(
    listener: TcpListener,
    router: Router,
    tls: Option<Arc<rustls::ServerConfig>>,
    mut stop: watch::Receiver<Option<String>>,
) {
    let acceptor = tls.map(TlsAcceptor::from);
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            _ = stop.changed() => break,
        };
        let (stream, peer) = match accepted {
            Ok(pair) => pair,
            Err(_) => {
                // Out of file descriptors or similar: back off briefly.
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let _ = stream.set_nodelay(true);
        let ip = netinfo::canonical_ip(peer.ip());
        let router = router.clone();
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            let _permit = permit;
            match acceptor {
                Some(acceptor) => {
                    if let Ok(Ok(tls)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
                        connection(tls, ip, router).await;
                    }
                }
                None => connection(stream, ip, router).await,
            }
        });
    }
}

/// Runs HTTP/1.1 over one connection.
async fn connection<S>(io: S, ip: IpAddr, router: Router)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let service = hyper::service::service_fn(move |mut request: hyper::Request<Incoming>| {
        request.extensions_mut().insert(PeerIp(ip));
        let router = router.clone();
        async move { Ok::<_, Infallible>(router.oneshot(request).await.unwrap_or_else(|never| match never {})) }
    });
    let _ = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_TIMEOUT)
        .keep_alive(true)
        .max_buf_size(64 * 1024)
        .serve_connection(TokioIo::new(io), service)
        .with_upgrades()
        .await;
}
