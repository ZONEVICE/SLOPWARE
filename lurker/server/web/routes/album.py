"""Opening, closing and rescanning the album, and syncing its catalog."""
import gzip
import json
import threading

from ...domain.errors import AppError
from ..respond import Response, accepts_gzip


class _SnapshotCache:
    """The last full catalog, encoded once and shared by every browser that loads it."""

    def __init__(self):
        self.lock = threading.Lock()
        self.key = None
        self.raw = self.packed = None

    def get(self, key, build):
        with self.lock:
            if self.key == key:
                return self.raw, self.packed
        raw = json.dumps(build(), separators=(',', ':'), ensure_ascii=False).encode('utf-8')
        packed = gzip.compress(raw, 6)
        with self.lock:
            self.key, self.raw, self.packed = key, raw, packed
        return raw, packed


def register(router, services):
    album = services.album
    cache = _SnapshotCache()

    def open_album(request):
        return Response.json(album.open(str(request.json().get('path', ''))), 202)

    def close_album(request):
        request.json()  # insists on a JSON body, which cross-site forms cannot send
        return Response.json(album.close())

    def rescan(request):
        return Response.json(album.rescan(request.json().get('album')), 202)

    def delta(request):
        album_id = request.arg('album')
        try:
            since = int(request.arg('since', '0'))
        except ValueError:
            raise AppError(400, 'bad_since', 'since must be a number.') from None
        if since > 0:
            return Response.json(album.delta(album_id, since))
        status = album.status()
        if status['status'] == 'empty' or (album_id and album_id != status.get('id')):
            album.delta(album_id, 0)  # raises the right error
        raw, packed = cache.get((status['id'], status['rev']), lambda: album.delta(status['id'], 0))
        headers = [('Cache-Control', 'no-store')]
        if accepts_gzip(request):
            headers += [('Content-Encoding', 'gzip'), ('Vary', 'Accept-Encoding')]
            return Response(200, packed, 'application/json; charset=utf-8', headers)
        return Response(200, raw, 'application/json; charset=utf-8', headers)

    router.post('/api/album/open', open_album)
    router.post('/api/album/close', close_album)
    router.post('/api/album/rescan', rescan)
    router.get('/api/album/delta', delta)
