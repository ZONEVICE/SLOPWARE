//! A connection that is either plain TCP or TLS over TCP, readable and
//! writable as one stream, with the raw socket kept at hand for timeouts and
//! for closing it from another thread.

use rustls::{ClientConnection, ServerConnection, StreamOwned};
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};

pub enum Stream {
    Plain(TcpStream),
    TlsServer(Box<StreamOwned<ServerConnection, TcpStream>>),
    TlsClient(Box<StreamOwned<ClientConnection, TcpStream>>),
}

impl Stream {
    pub fn socket(&self) -> &TcpStream {
        match self {
            Stream::Plain(socket) => socket,
            Stream::TlsServer(tls) => &tls.sock,
            Stream::TlsClient(tls) => &tls.sock,
        }
    }

    pub fn set_timeout(&self, millis: u64) {
        let timeout = if millis == 0 { None } else { Some(std::time::Duration::from_millis(millis)) };
        let _ = self.socket().set_read_timeout(timeout);
        let _ = self.socket().set_write_timeout(timeout);
    }

    /// A handle that can shut the connection down from another thread.
    pub fn closer(&self) -> Option<TcpStream> {
        self.socket().try_clone().ok()
    }

    pub fn shutdown(&self) {
        let _ = self.socket().shutdown(Shutdown::Both);
    }
}

impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let result = match self {
            Stream::Plain(socket) => socket.read(buffer),
            Stream::TlsServer(tls) => tls.read(buffer),
            Stream::TlsClient(tls) => tls.read(buffer),
        };
        // A peer that closes without TLS close_notify is an ordinary end of
        // stream for HTTP, which frames its own messages.
        match result {
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof && !matches!(self, Stream::Plain(_)) => Ok(0),
            other => other,
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self {
            Stream::Plain(socket) => socket.write(buffer),
            Stream::TlsServer(tls) => tls.write(buffer),
            Stream::TlsClient(tls) => tls.write(buffer),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Stream::Plain(socket) => socket.flush(),
            Stream::TlsServer(tls) => tls.flush(),
            Stream::TlsClient(tls) => tls.flush(),
        }
    }
}
