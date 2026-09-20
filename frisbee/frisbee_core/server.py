# -*- coding: utf-8 -*-
"""HTTP adapters: keep transport, filesystem operations, and background jobs separate."""
from __future__ import unicode_literals

import errno
import json
import mimetypes
import os
import re
import socket
import threading
import time
import uuid

try:
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from socketserver import ThreadingMixIn
    from urllib.parse import parse_qs, quote, urlsplit
except ImportError:  # Python 2.7 uses the same APIs under older module names.
    from BaseHTTPServer import BaseHTTPRequestHandler, HTTPServer
    from SocketServer import ThreadingMixIn
    from urllib import quote
    from urlparse import parse_qs, urlsplit

from .compat import fs_text, text_type
from .jobs import JobStore
from .storage import FileStore, NoteStore, StorageError, WorkspaceStore


STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(fs_text(__file__)))), 'static')


class ArchiveStore(object):
    """Retain disk-backed ZIPs briefly so browser downloads can retry or resume."""

    def __init__(self, file_store):
        self.files = file_store
        self.lock = threading.RLock()
        self.archives = {}

    def create(self, workspace, paths):
        stream = self.files.build_zip(workspace, paths)
        identifier = uuid.uuid4().hex
        with self.lock:
            for key, entry in list(self.archives.items()):
                if time.time() - entry['created'] > 1800 and entry['lock'].acquire(False):
                    try:
                        entry['stream'].close()
                        del self.archives[key]
                    finally:
                        entry['lock'].release()
            self.archives[identifier] = {'stream': stream, 'created': time.time(), 'lock': threading.RLock()}
        return {'download_url': '/api/archives/' + identifier}

    def acquire(self, identifier):
        with self.lock:
            entry = self.archives.get(identifier)
            if entry is None:
                raise StorageError('This ZIP download expired. Create the archive again.', 404)
            entry['lock'].acquire()
            return entry

    def close(self):
        with self.lock:
            for entry in self.archives.values():
                with entry['lock']:
                    entry['stream'].close()
            self.archives.clear()


class FrisbeeServer(ThreadingMixIn, HTTPServer):
    """One process serves concurrent browsers, uploads, notes, and progress polls."""

    daemon_threads = True
    allow_reuse_address = True

    def server_close(self):
        HTTPServer.server_close(self)
        if hasattr(self, 'job_store'):
            self.job_store.close()
        if hasattr(self, 'archive_store'):
            self.archive_store.close()


class RequestHandler(BaseHTTPRequestHandler):
    server_version = 'Frisbee/1.0'
    # Closing each response also prevents an unread failed upload body from
    # becoming the next request; browsers transparently establish new connections.
    protocol_version = 'HTTP/1.0'

    def log_message(self, template, *args):
        # Avoid echoing query parameters (host paths and filenames) into logs.
        pass

    def do_GET(self):
        self._dispatch('GET')

    def do_HEAD(self):
        self._dispatch('GET', head=True)

    def do_POST(self):
        self._dispatch('POST')

    def do_PUT(self):
        self._dispatch('PUT')

    def do_DELETE(self):
        self._dispatch('DELETE')

    def _headers(self, status, content_type, length, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy',
                         "default-src 'self'; script-src 'self'; style-src 'self'; "
                         "img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self._response_started = True

    def _json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=True).encode('utf-8')
        self._headers(status, 'application/json; charset=utf-8', len(data))
        if not self._head:
            self.wfile.write(data)

    def _length(self):
        if self.headers.get('Transfer-Encoding'):
            raise StorageError('Chunked requests are not supported. Send Content-Length.', 411)
        value = self.headers.get('Content-Length')
        if value is None:
            raise StorageError('Content-Length is required.', 411)
        try:
            length = int(value)
        except ValueError:
            raise StorageError('Invalid Content-Length.')
        if length < 0:
            raise StorageError('Invalid Content-Length.')
        return length

    def _body(self):
        if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
            raise StorageError('Send JSON using Content-Type: application/json.', 415)
        length = self._length()
        data = self.rfile.read(length)
        if len(data) != length:
            raise StorageError('The request body was interrupted.')
        try:
            body = json.loads(data.decode('utf-8'))
        except (ValueError, UnicodeError):
            raise StorageError('The request body must contain valid UTF-8 JSON.')
        if not isinstance(body, dict):
            raise StorageError('The JSON body must be an object.')
        return body

    @staticmethod
    def _required(body, key):
        if key not in body:
            raise StorageError('Missing field: %s.' % key)
        return body[key]

    def _origin(self):
        # There is intentionally no authentication. Same-origin checks only stop
        # an unrelated browser page from silently submitting filesystem changes.
        origin = self.headers.get('Origin')
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme not in ('http', 'https') or parsed.netloc.lower() != self.headers.get('Host', '').lower():
                raise StorageError('Cross-origin changes are not allowed.', 403)

    def _dispatch(self, method, head=False):
        self._head = head
        self._response_started = False
        try:
            parsed = urlsplit(self.path)
            route = parsed.path
            query = parse_qs(parsed.query, keep_blank_values=True)

            def parameter(key, default=None):
                value = query.get(key, [default])[0]
                if value is not None and not isinstance(value, text_type):
                    value = value.decode('utf-8')
                return value

            if method != 'GET':
                self._origin()
            files = self.server.file_store
            notes = self.server.note_store
            workspace = parameter('workspace')
            path = parameter('path', '')
            if method == 'GET' and route == '/api/health':
                return self._json({'status': 'ok', 'application': 'Frisbee'})
            if method == 'GET' and route in ('/', '/index.html', '/app.js', '/app.css', '/static/app.js', '/static/app.css'):
                name, mime = {'/': ('index.html', 'text/html; charset=utf-8'),
                              '/index.html': ('index.html', 'text/html; charset=utf-8'),
                              '/app.js': ('app.js', 'application/javascript; charset=utf-8'),
                              '/app.css': ('app.css', 'text/css; charset=utf-8'),
                              '/static/app.js': ('app.js', 'application/javascript; charset=utf-8'),
                              '/static/app.css': ('app.css', 'text/css; charset=utf-8')}[route]
                with open(os.path.join(STATIC_DIR, name), 'rb') as stream:
                    return self._stream(stream, mime)
            if method == 'POST' and route == '/api/workspaces':
                body = self._body()
                result = self.server.workspace_store.create(self._required(body, 'mode'), body.get('path'))
                return self._json({'workspace': result}, 201)
            if method == 'GET' and route == '/api/workspace':
                return self._json({'workspace': self.server.workspace_store.get(workspace)})
            if method == 'GET' and route == '/api/files':
                return self._json(files.list(workspace, path))
            if route == '/api/content':
                if method == 'GET':
                    return self._json(files.content(workspace, path))
                if method == 'PUT':
                    body = self._body()
                    return self._json(files.save_content(self._required(body, 'workspace'),
                                                        self._required(body, 'path'),
                                                        self._required(body, 'content'), body.get('revision')))
            if method == 'GET' and route in ('/api/download', '/api/preview'):
                absolute = files.raw_file(workspace, path)
                media_type = files.media_type(absolute)
                mime = media_type or mimetypes.guess_type(absolute)[0] or 'application/octet-stream'
                if route == '/api/preview' and media_type is None and not mime.startswith('image/'):
                    raise StorageError('Only images and recognized video formats can be previewed at this endpoint.', 415)
                headers = {}
                if route == '/api/preview':
                    headers['Content-Security-Policy'] = "sandbox; default-src 'none'"
                # Images and videos share the existing seekable, chunked path.
                # HEAD and byte ranges let native video controls seek without
                # buffering the complete file or adding a transcoding process.
                with open(absolute, 'rb') as stream:
                    return self._stream(stream, mime, os.path.basename(absolute) if route == '/api/download' else None, headers)
            if method == 'POST' and route == '/api/upload':
                result = files.receive_upload(workspace, path, parameter('name'), self.rfile, self._length())
                return self._json(result, 201)
            if method == 'POST' and route in ('/api/rename', '/api/delete', '/api/directories', '/api/move', '/api/archives'):
                body = self._body()
                workspace = self._required(body, 'workspace')
                if route == '/api/rename':
                    return self._json(files.rename(workspace, self._required(body, 'path'), self._required(body, 'name')))
                if route == '/api/delete':
                    return self._json(files.delete(workspace, self._required(body, 'paths')))
                if route == '/api/directories':
                    return self._json(files.create_directory(workspace, body.get('path', ''), self._required(body, 'name')), 201)
                if route == '/api/move':
                    job = self.server.job_store.start(workspace, self._required(body, 'paths'), self._required(body, 'destination'))
                    return self._json({'job': job}, 202)
                return self._json(self.server.archive_store.create(workspace, self._required(body, 'paths')), 201)
            if method == 'GET' and route.startswith('/api/jobs/'):
                return self._json({'job': self.server.job_store.get(route[len('/api/jobs/'):])})
            if method == 'GET' and route.startswith('/api/archives/'):
                entry = self.server.archive_store.acquire(route[len('/api/archives/'):])
                try:
                    return self._stream(entry['stream'], 'application/zip', 'frisbee-selection.zip')
                finally:
                    entry['lock'].release()
            if route == '/api/notes':
                name = parameter('name')
                if method == 'GET':
                    return self._json(notes.get(name) if name is not None else notes.list())
                if method in ('POST', 'PUT'):
                    body = self._body()
                    result = notes.save(self._required(body, 'name'), self._required(body, 'content'),
                                        body.get('revision'), create=(method == 'POST'))
                    return self._json(result, 201 if method == 'POST' else 200)
                if method == 'DELETE':
                    return self._json(notes.delete(name))
            raise StorageError('This endpoint does not exist.', 404)
        except StorageError as error:
            self._fail(error.status, error.message)
        except (ValueError, TypeError, UnicodeError) as error:
            self._fail(400, 'Invalid request: %s' % error)
        except (OSError, IOError) as error:
            if getattr(error, 'errno', None) in (errno.EPIPE, errno.ECONNRESET, errno.ECONNABORTED):
                self.close_connection = True
                return
            code = getattr(error, 'errno', None)
            status = 403 if code in (errno.EACCES, errno.EPERM) else 404 if code in (errno.ENOENT, errno.ENOTDIR) else 409 if code == errno.EEXIST else 500
            self._fail(status, 'Filesystem operation failed: %s' % error)
        except Exception as error:
            self._fail(500, 'The operation could not be completed: %s' % error)

    def _fail(self, status, message):
        if self._response_started:
            self.close_connection = True
            return
        try:
            self._json({'error': message}, status)
        except (socket.error, IOError):
            self.close_connection = True

    def _stream(self, stream, mime, filename=None, extra=None):
        """Stream from disk in fixed chunks; byte ranges allow resumed downloads."""
        stream.seek(0, os.SEEK_END)
        length = stream.tell()
        start, end, status = 0, length - 1, 200
        headers = dict(extra or {})
        headers['Accept-Ranges'] = 'bytes'
        requested = self.headers.get('Range')
        if requested:
            match = re.match(r'^bytes=(\d*)-(\d*)$', requested.strip())
            valid = bool(match and (match.group(1) or match.group(2)) and length)
            if valid:
                if not match.group(1):
                    suffix = int(match.group(2))
                    valid = suffix > 0
                    start = max(0, length - suffix)
                else:
                    start = int(match.group(1))
                    end = min(int(match.group(2)), length - 1) if match.group(2) else length - 1
                valid = valid and start <= end and start < length
            if not valid:
                self._headers(416, mime, 0, {'Content-Range': 'bytes */%s' % length})
                return
            status = 206
            headers['Content-Range'] = 'bytes %s-%s/%s' % (start, end, length)
        if filename is not None:
            ascii_name = re.sub(r'[^a-zA-Z0-9_. -]', '_', filename) or 'download'
            headers['Content-Disposition'] = 'attachment; filename="%s"; filename*=UTF-8\'\'%s' % (ascii_name, quote(filename.encode('utf-8'), safe=''))
        remaining = max(0, end - start + 1)
        self._headers(status, mime, remaining, headers)
        if self._head:
            return
        stream.seek(start)
        while remaining:
            chunk = stream.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            self.wfile.write(chunk)
            remaining -= len(chunk)


def create_server(host='0.0.0.0', port=8080, base_dir=None):
    """Construct without serving, allowing embedders and tests to use port zero."""
    if base_dir is None:
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(fs_text(__file__))))
    workspaces = WorkspaceStore(base_dir)
    notes = NoteStore(base_dir)
    files = FileStore(workspaces)
    server = FrisbeeServer((host, port), RequestHandler)
    server.workspace_store = workspaces
    server.file_store = files
    server.note_store = notes
    server.job_store = JobStore(files)
    server.archive_store = ArchiveStore(files)
    return server


def create_available_server(host='0.0.0.0', port=8080, base_dir=None):
    """Bind the first available port at or above the requested starting port.

    Attempt the real server bind instead of probing with a separate socket: a
    free-port probe can lose a race before the actual server claims the port.
    Only address-in-use errors permit a retry; unrelated failures must remain
    visible. Keep create_server strict for callers that require an exact port.
    """
    if not 0 <= port <= 65535:
        raise ValueError('The port must be between 0 and 65535.')
    candidate = port
    while True:
        try:
            return create_server(host, candidate, base_dir)
        except (socket.error, OSError, IOError) as error:
            # Python 2 and Windows may expose Winsock errors through errno,
            # winerror, or the first argument rather than the POSIX errno value.
            codes = (getattr(error, 'errno', None), getattr(error, 'winerror', None),
                     error.args[0] if error.args else None)
            if candidate == 0 or not any(code in (errno.EADDRINUSE, 10048) for code in codes):
                raise
            if candidate == 65535:
                raise socket.error(errno.EADDRINUSE,
                                   'No available port from %s through 65535.' % port)
            candidate += 1
