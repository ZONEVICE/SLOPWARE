"""WebP: VP8 (lossy), VP8L (lossless) and VP8X (extended: animation, EXIF)."""
from .. import exif
from ..binary import BytesSource, Malformed, u16le, u24le, u32le


def read(source, detail=False):
    header = source.read(0, 30)
    if len(header) < 30 or header[:4] != b'RIFF' or header[8:12] != b'WEBP':
        raise Malformed('not a WebP')
    kind = header[12:16]
    result = {}
    if kind == b'VP8 ':
        if header[23:26] != b'\x9d\x01\x2a':
            raise Malformed('bad VP8 start code')
        result['width'] = u16le(header, 26) & 0x3FFF
        result['height'] = u16le(header, 28) & 0x3FFF
    elif kind == b'VP8L':
        if header[20] != 0x2F:
            raise Malformed('bad VP8L signature')
        bits = u32le(header, 21)
        result['width'] = (bits & 0x3FFF) + 1
        result['height'] = ((bits >> 14) & 0x3FFF) + 1
    elif kind == b'VP8X':
        flags = header[20]
        result['width'] = u24le(header, 24) + 1
        result['height'] = u24le(header, 27) + 1
        if flags & 0x02:
            result['animated'] = True
        if flags & 0x08:
            _read_exif(source, result, detail)
    else:
        raise Malformed('unknown WebP chunk')
    return result


def _read_exif(source, result, detail):
    position = 12
    for _ in range(64):
        head = source.read(position, 8)
        if len(head) < 8:
            return
        size = u32le(head, 4)
        if head[:4] == b'EXIF' and size <= 1 << 20:
            payload = source.read(position + 8, size)
            if payload.startswith(b'Exif\x00\x00'):  # some writers keep the JPEG prefix
                payload = payload[6:]
            try:
                info = exif.parse(BytesSource(payload), detail=detail)
            except Malformed:
                return
            # Browsers ignore EXIF orientation in WebP, so only dates and camera count.
            for key in ('taken', 'camera', 'details'):
                if key in info:
                    result[key] = info[key]
            return
        position += 8 + size + (size & 1)
