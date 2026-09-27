"""PNG: IHDR dimensions, APNG animation (acTL), and an eXIf chunk's date."""
from .. import exif
from ..binary import BytesSource, Malformed, u32be

SIGNATURE = b'\x89PNG\r\n\x1a\n'


def read(source, detail=False):
    if source.read(0, 8) != SIGNATURE:
        raise Malformed('not a PNG')
    result = {}
    position = 8
    for _ in range(256):
        head = source.read(position, 8)
        if len(head) < 8:
            break
        length = u32be(head, 0)
        kind = head[4:8]
        if kind == b'IHDR':
            data = source.exact(position + 8, 8)
            result['width'] = u32be(data, 0)
            result['height'] = u32be(data, 4)
        elif kind == b'acTL':
            data = source.read(position + 8, 4)
            if len(data) == 4 and u32be(data, 0) > 1:
                result['animated'] = True
        elif kind == b'eXIf' and length <= 1 << 20:
            try:
                info = exif.parse(BytesSource(source.read(position + 8, length)), detail=detail)
            except Malformed:
                info = {}
            # Browsers do not apply eXIf orientation to PNG consistently, so it is ignored.
            for key in ('taken', 'camera', 'details'):
                if key in info:
                    result[key] = info[key]
        elif kind in (b'IDAT', b'IEND'):
            break  # acTL and eXIf must come before the image data
        position += 12 + length
    if not result.get('width') or not result.get('height'):
        raise Malformed('PNG without IHDR')
    return result
