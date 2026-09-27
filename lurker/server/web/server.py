"""The HTTP(S) server: one thread per connection, keep-alive, TLS done right.

Three details matter here:

* The TLS handshake runs in the connection's own thread. Wrapping the
  listening socket instead would handshake inside accept(), where one slow or
  hostile client would stall every other one.
* A plain-HTTP request sent to the HTTPS port (someone typed http://) gets a
  redirect to the https:// address instead of a connection reset. The first
  byte tells them apart: a TLS handshake always starts with 0x16.
* Every open connection is tracked, so shutting down can close idle
  keep-alive sockets and event streams instead of waiting for them.
"""
import logging
import os
import socket
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log = logging.getLogger('lurker.http')

_TLS_HANDSHAKE = 0x16
_HANDSHAKE_TIMEOUT = 10


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'Lurker'
    sys_version = ''
    timeout = 60  # an idle keep-alive connection is closed after a minute

    def version_string(self):
        return 'Lurker'

    def do_GET(self):
        self.server.web.handle(self)

    do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_GET

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionError, ssl.SSLError, socket.timeout, OSError):
            self.close_connection = True

    def log_message(self, format, *args):
        self.server.web.log_access(self, format % args)

    def log_error(self, format, *args):
        log.debug('%s %s', self.client_address[0] if self.client_address else '-', format % args)


class LurkerHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second process steal a port in use, which
    # would defeat the free-port walk; SO_EXCLUSIVEADDRUSE is set instead.
    allow_reuse_address = os.name != 'nt'
    request_queue_size = 128

    def __init__(self, address, web, ssl_context=None, handler=Handler):
        self.web = web
        self.ssl_context = ssl_context
        self._connections = set()
        self._connections_lock = threading.Lock()
        super().__init__(address, handler)

    def server_bind(self):
        if os.name == 'nt' and hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def finish_request(self, request, client_address):
        connection = request
        if self.ssl_context is not None:
            connection = self._accept_tls(request, client_address)
            if connection is None:
                return
        with self._connections_lock:
            self._connections.add(connection)
        try:
            self.RequestHandlerClass(connection, client_address, self)
        finally:
            with self._connections_lock:
                self._connections.discard(connection)
            if connection is not request:
                # The TLS socket took over the file descriptor; the server's own
                # shutdown_request() only sees the detached original.
                _close_quietly(connection)

    def close_connections(self):
        with self._connections_lock:
            connections = list(self._connections)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def handle_error(self, request, client_address):
        log.debug('Connection error from %s', client_address, exc_info=True)

    def _accept_tls(self, raw, client_address):
        try:
            raw.settimeout(_HANDSHAKE_TIMEOUT)
            first = raw.recv(1, socket.MSG_PEEK)
        except OSError:
            return None
        if not first:
            return None
        if first[0] != _TLS_HANDSHAKE:
            _redirect_to_https(raw, self.server_address[1])
            return None
        try:
            return self.ssl_context.wrap_socket(raw, server_side=True)
        except (ssl.SSLError, OSError) as error:
            # Normal on first contact: the browser refuses the self-signed
            # certificate until the user accepts it, and retries.
            log.debug('TLS handshake with %s failed: %s', client_address[0], error)
            return None


def _redirect_to_https(raw, port):
    head = b''
    try:
        while b'\r\n\r\n' not in head and len(head) < 16384:
            chunk = raw.recv(4096)
            if not chunk:
                break
            head += chunk
    except OSError:
        return
    lines = head.split(b'\r\n')
    try:
        target = lines[0].split(b' ')[1].decode('ascii')
    except (IndexError, UnicodeDecodeError):
        return
    host = None
    for line in lines[1:]:
        if line.lower().startswith(b'host:'):
            host = line[5:].strip().decode('ascii', 'replace')
            break
    if not target.startswith('/'):
        target = '/'
    if not host or any(ch in host for ch in '\r\n /\\@'):
        host = 'localhost:%d' % port
    body = b'This Lurker speaks HTTPS. Use https:// in the address.\n'
    response = (
        'HTTP/1.1 307 Temporary Redirect\r\n'
        'Location: https://%s%s\r\n'
        'Cache-Control: no-store\r\n'
        'Content-Type: text/plain; charset=utf-8\r\n'
        'Content-Length: %d\r\n'
        'Connection: close\r\n\r\n' % (host, target, len(body))
    ).encode('ascii', 'replace') + body
    try:
        raw.sendall(response)
    except OSError:
        pass


def _close_quietly(connection):
    try:
        connection.shutdown(socket.SHUT_WR)
    except OSError:
        pass
    try:
        connection.close()
    except OSError:
        pass
