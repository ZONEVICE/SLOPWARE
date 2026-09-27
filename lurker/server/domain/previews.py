"""Embedded JPEG previews: EXIF thumbnails and the big JPEGs inside camera RAWs.

A camera JPEG usually carries a ~160 px thumbnail in its EXIF block, which
makes a tile appear instantly while the full photo loads. A RAW file carries
a large JPEG that stands in for the photo itself. Neither stores the photo's
orientation, so a one-tag EXIF segment is inserted after the preview's SOI
marker, and browsers then rotate it exactly like the original.

Small previews are cached in memory (bounded); large ones are read on demand.
"""
import threading
from collections import OrderedDict

from ..media.exif import orientation_segment
from .errors import AppError

_CACHE_LIMIT = 48 * 1024 * 1024
_CACHEABLE = 256 * 1024
_MAX_PREVIEW = 32 * 1024 * 1024


class Previews:
    def __init__(self, cache_limit=_CACHE_LIMIT):
        self._limit = cache_limit
        self._size = 0
        self._cache = OrderedDict()
        self._lock = threading.Lock()

    def get(self, item, path):
        """The preview JPEG of `item` as bytes, or AppError 404 when it has none."""
        if not item.preview:
            raise AppError(404, 'no_preview', 'This file has no embedded preview.')
        offset, length = item.preview
        if length > _MAX_PREVIEW:
            raise AppError(404, 'no_preview', 'The embedded preview is too large.')
        key = (path, item.version)
        with self._lock:
            cached = self._cache.get(key)
            if cached is not None:
                self._cache.move_to_end(key)
                return cached
        try:
            with open(path, 'rb') as handle:
                handle.seek(offset)
                data = handle.read(length)
        except OSError:
            raise AppError(404, 'not_found', 'The file can no longer be read.') from None
        if len(data) != length or not data.startswith(b'\xff\xd8'):
            raise AppError(404, 'no_preview', 'The embedded preview is damaged.')
        data = with_orientation(data, item.orientation)
        if len(data) <= _CACHEABLE:
            with self._lock:
                if key not in self._cache:
                    self._cache[key] = data
                    self._size += len(data)
                    while self._size > self._limit and self._cache:
                        _, evicted = self._cache.popitem(last=False)
                        self._size -= len(evicted)
        return data


def with_orientation(jpeg, orientation):
    """Insert an EXIF orientation tag unless the JPEG already has an EXIF block."""
    if not orientation or orientation == 1:
        return jpeg
    if b'Exif\x00\x00' in jpeg[:4096]:
        return jpeg
    return jpeg[:2] + orientation_segment(orientation) + jpeg[2:]
