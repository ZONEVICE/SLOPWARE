"""JPEG: dimensions from the SOF segment, EXIF from APP1, the embedded thumbnail."""
from .. import exif
from ..binary import BytesSource, Malformed, u16be

# Start-of-frame markers (every coding process except DHT/JPG/DAC).
_SOF = frozenset((0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF))
_PROGRESSIVE = frozenset((0xC2, 0xC6, 0xCA, 0xCE))


def read(source, detail=False):
    if source.read(0, 3) != b'\xff\xd8\xff':
        raise Malformed('not a JPEG')
    result = {}
    position = 2
    for _ in range(1024):
        head = source.read(position, 4)
        if len(head) < 2 or head[0] != 0xFF:
            break
        marker = head[1]
        if marker == 0xFF:           # fill byte
            position += 1
            continue
        if marker in (0x01, 0xD8) or 0xD0 <= marker <= 0xD7:
            position += 2            # markers without a length
            continue
        if marker in (0xD9, 0xDA) or len(head) < 4:
            break                    # end of image / start of scan: no more headers
        length = u16be(head, 2)
        if length < 2:
            break
        if marker in _SOF:
            frame = source.read(position + 4, 5)
            if len(frame) == 5:
                result['height'] = u16be(frame, 1)
                result['width'] = u16be(frame, 3)
                if marker in _PROGRESSIVE:
                    result['progressive'] = True
            break
        if marker == 0xE1 and 'exifRead' not in result:
            payload = source.read(position + 4, min(length - 2, 0xFFFF))
            if payload.startswith(b'Exif\x00\x00'):
                result['exifRead'] = True
                try:
                    info = exif.parse(BytesSource(payload, 6), detail=detail)
                except Malformed:
                    info = {}
                _merge_exif(result, info, tiff_start=position + 4 + 6, file_size=source.size)
        position += 2 + length
    result.pop('exifRead', None)
    if not result.get('width') or not result.get('height'):
        result.pop('width', None)
        result.pop('height', None)
    return result


def _merge_exif(result, info, tiff_start, file_size):
    for key in ('orientation', 'camera', 'taken', 'details'):
        if key in info:
            result[key] = info[key]
    thumbnail = info.get('thumbnail')
    if thumbnail:
        start, length = thumbnail
        absolute = tiff_start + start
        if 0 < length and absolute + length <= file_size:
            result['preview'] = (absolute, length)
