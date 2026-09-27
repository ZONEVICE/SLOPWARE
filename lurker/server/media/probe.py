"""Read one file's metadata, whatever state the file is in.

The extension picks the reader, unless the first bytes clearly say otherwise
(a ".jpg" that is really a PNG is common in downloads); the content wins.
A truncated or corrupt file yields whatever could be read before the damage,
never an exception.
"""
import os
import struct

from .binary import Malformed, Source
from .readers import READERS
from .readers.riff import is_transport_stream

_READ_ERRORS = (Malformed, struct.error, ValueError, IndexError, OverflowError, UnicodeDecodeError, KeyError)


def sniff(head):
    """The reader key the content itself asks for, or None."""
    if head[:3] == b'\xff\xd8\xff':
        return 'jpeg'
    if head[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if head[:6] in (b'GIF87a', b'GIF89a'):
        return 'gif'
    if head[:4] == b'RIFF':
        return {b'WEBP': 'webp', b'AVI ': 'riff'}.get(head[8:12])
    if head[:4] == b'\x1a\x45\xdf\xa3':
        return 'ebml'
    if head[4:8] == b'ftyp':
        return 'isobmff'
    if head[:4] in (b'II*\x00', b'MM\x00*', b'IIRO', b'IIU\x00'):
        return 'tiff'
    if head[:4] == b'8BPS':
        return 'psd'
    if head[:15] == b'FUJIFILMCCD-RAW':
        return 'raf'
    if is_transport_stream(head):
        return 'mpegts'
    return None


def probe(path, fmt, detail=False):
    """Metadata for the file at `path`, registered as Format `fmt`.

    Returns the reader's keys (see readers/__init__.py) plus `displayWidth`
    and `displayHeight`: the size as a browser shows it, after EXIF
    orientation or rotation. Raises OSError only when the file cannot be
    opened at all.
    """
    with open(path, 'rb') as handle:
        size = os.fstat(handle.fileno()).st_size
        source = Source(handle, size)
        head = source.read(0, 400)
        reader_key = fmt.reader if fmt else None
        actual = sniff(head)
        if actual and actual != reader_key:
            reader_key = actual
        reader = READERS.get(reader_key)
        if reader is None:
            return {}
        try:
            result = reader(source, detail=detail)
        except _READ_ERRORS:
            result = {}
    return finish(result)


def finish(result):
    width, height = result.get('width'), result.get('height')
    if width and height and width > 0 and height > 0:
        swap = result.get('orientation', 1) in (5, 6, 7, 8) or result.get('rotation') in (90, 270)
        result['displayWidth'], result['displayHeight'] = (height, width) if swap else (width, height)
    else:
        result.pop('width', None)
        result.pop('height', None)
    duration = result.get('duration')
    if duration is not None and not (0 < duration < 10 * 365 * 86400):
        result.pop('duration')
    return result


def content_matches(path, fmt):
    """For extensions shared with non-media files (.ts): is this really video?"""
    try:
        with open(path, 'rb') as handle:
            head = handle.read(400)
    except OSError:
        return False
    if fmt.key == 'mpegts':
        return is_transport_stream(head)
    return True
