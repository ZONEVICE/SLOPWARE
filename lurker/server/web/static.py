"""The browser application's own files, from public/."""
import gzip
import hashlib
import os
import threading

from .. import PUBLIC_DIR
from ..domain.errors import AppError
from .respond import APP_CSP, Response, accepts_gzip

TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
}


class StaticFiles:
    def __init__(self, root=PUBLIC_DIR):
        self.root = os.path.realpath(root)
        self._cache = {}
        self._lock = threading.Lock()

    def response(self, request, relative):
        path = self._resolve(relative)
        info = os.stat(path)
        etag = '"%s"' % hashlib.sha1(('%s:%d:%d' % (relative, info.st_size, info.st_mtime_ns)).encode()).hexdigest()[:16]
        extension = os.path.splitext(path)[1].lower()
        headers = [('ETag', etag), ('Cache-Control', 'no-cache')]
        if extension == '.html':
            headers.append(('Content-Security-Policy', APP_CSP))
        if etag in (request.header('If-None-Match') or ''):
            return Response(304, b'', None, headers)
        raw, packed = self._load(path, etag)
        response = Response(200, raw, TYPES[extension], headers)
        if packed is not None and accepts_gzip(request):
            response.body = packed
            response.headers += [('Content-Encoding', 'gzip'), ('Vary', 'Accept-Encoding')]
        return response

    def _resolve(self, relative):
        parts = [part for part in relative.split('/') if part]
        if not parts:
            parts = ['index.html']
        if any(part.startswith('.') or '\\' in part or '\x00' in part for part in parts):
            raise AppError(404, 'not_found', 'Nothing here.')
        path = os.path.realpath(os.path.join(self.root, *parts))
        if not path.startswith(self.root + os.sep) or not os.path.isfile(path):
            raise AppError(404, 'not_found', 'Nothing here.')
        if os.path.splitext(path)[1].lower() not in TYPES:
            raise AppError(404, 'not_found', 'Nothing here.')
        return path

    def _load(self, path, etag):
        with self._lock:
            cached = self._cache.get(path)
            if cached and cached[0] == etag:
                return cached[1], cached[2]
        with open(path, 'rb') as handle:
            raw = handle.read()
        compressible = TYPES[os.path.splitext(path)[1].lower()].startswith(('text/', 'image/svg', 'application/'))
        packed = gzip.compress(raw, 9) if compressible and len(raw) > 1024 else None
        with self._lock:
            self._cache[path] = (etag, raw, packed)
        return raw, packed
