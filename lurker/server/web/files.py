"""Streaming a file from disk: conditional requests and byte ranges.

Video players seek with Range requests (a browser will not scrub through a
large MP4 without "206 Partial Content"), and browsers revalidate cached
images with If-None-Match. Plain HTTP uses the kernel's sendfile; TLS cannot,
so it copies in large blocks.
"""
import email.utils
import errno
import os
import re
import ssl
import stat
from urllib.parse import quote

from ..domain.errors import AppError
from .respond import MEDIA_CSP, send_headers

_RANGE = re.compile(r'^bytes=(\d*)-(\d*)$')
_BLOCK = 256 * 1024


def content_disposition(disposition, filename):
    fallback = ''.join(ch if 32 <= ord(ch) < 127 and ch not in '"\\;' else '_' for ch in filename) or 'file'
    return '%s; filename="%s"; filename*=UTF-8\'\'%s' % (disposition, fallback, quote(filename, safe=''))


def parse_range(header, size):
    """(start, end) inclusive, None for "send everything", or 'unsatisfiable'."""
    if not header:
        return None
    match = _RANGE.match(header.strip().replace(' ', ''))
    if not match:
        return None  # malformed or multiple ranges: ignoring Range is always allowed
    first, last = match.groups()
    if first == '' and last == '':
        return None
    if first == '':
        length = int(last)
        if length == 0:
            return 'unsatisfiable'
        return max(0, size - length), size - 1
    start = int(first)
    end = size - 1 if last == '' else min(int(last), size - 1)
    if start >= size or start > end:
        return 'unsatisfiable'
    return start, end


def serve_file(handler, request, path, mime, filename, disposition='inline', cache='private, max-age=86400',
               extra_headers=()):
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOENT, errno.ENOTDIR, errno.EISDIR):
            raise AppError(404, 'not_found', 'The file is gone from the disk.') from None
        raise AppError(403, 'not_readable', 'The file cannot be read.') from None
    with os.fdopen(descriptor, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise AppError(404, 'not_found', 'That is not a regular file.')
        size = info.st_size
        etag = '"%x-%x"' % (size, info.st_mtime_ns)
        headers = [
            ('Content-Type', mime),
            ('Accept-Ranges', 'bytes'),
            ('ETag', etag),
            ('Last-Modified', email.utils.formatdate(info.st_mtime, usegmt=True)),
            ('Cache-Control', cache),
            ('Content-Disposition', content_disposition(disposition, filename)),
            ('Content-Security-Policy', MEDIA_CSP),
        ] + list(extra_headers)

        if _not_modified(request, etag, info.st_mtime):
            _finish_empty(handler, 304, headers)
            return

        wanted = parse_range(request.header('Range'), size)
        if wanted is not None and not _if_range_matches(request, etag, info.st_mtime):
            wanted = None
        if wanted == 'unsatisfiable':
            _finish_empty(handler, 416, headers + [('Content-Range', 'bytes */%d' % size)])
            return
        if wanted is None:
            status, start, length = 200, 0, size
        else:
            status, start, length = 206, wanted[0], wanted[1] - wanted[0] + 1
            headers.append(('Content-Range', 'bytes %d-%d/%d' % (wanted[0], wanted[1], size)))
        headers.append(('Content-Length', str(length)))
        request.streaming = True
        send_headers(handler, status, headers)
        if request.method == 'HEAD' or length == 0:
            return
        _copy(handler, handle, start, length)


def _not_modified(request, etag, mtime):
    tags = request.header('If-None-Match')
    if tags:
        return etag in [tag.strip() for tag in tags.split(',')] or tags.strip() == '*'
    since = request.header('If-Modified-Since')
    if since:
        try:
            return int(mtime) <= email.utils.parsedate_to_datetime(since).timestamp()
        except (TypeError, ValueError, IndexError, OverflowError):
            return False
    return False


def _if_range_matches(request, etag, mtime):
    value = request.header('If-Range')
    if not value:
        return True
    if value.startswith('"') or value.startswith('W/'):
        return value.strip() == etag
    try:
        return int(mtime) <= email.utils.parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError, IndexError, OverflowError):
        return False


def _finish_empty(handler, status, headers):
    keep = [(key, value) for key, value in headers if key.lower() not in ('content-length', 'content-type')
            or status == 416]
    keep.append(('Content-Length', '0'))
    send_headers(handler, status, keep)


def _copy(handler, handle, start, length):
    connection = handler.connection
    if not isinstance(connection, ssl.SSLSocket) and hasattr(connection, 'sendfile'):
        try:
            connection.sendfile(handle, start, length)
            return
        except (AttributeError, NotImplementedError):
            pass
    handle.seek(start)
    remaining = length
    buffer = bytearray(_BLOCK)
    view = memoryview(buffer)
    while remaining > 0:
        count = handle.readinto(view[:min(_BLOCK, remaining)])
        if not count:
            break  # the file shrank while being sent; the client sees a short body
        handler.wfile.write(view[:count])
        remaining -= count
