"""GIF: logical screen size, and whether there is more than one frame."""
from ..binary import Malformed, u16le

_BUDGET = 2 * 1024 * 1024  # enough to reach the second frame of nearly every animation


def read(source, detail=False):
    header = source.read(0, 13)
    if len(header) < 13 or header[:6] not in (b'GIF87a', b'GIF89a'):
        raise Malformed('not a GIF')
    result = {'width': u16le(header, 6), 'height': u16le(header, 8)}
    data = source.read(0, _BUDGET)
    flags = header[10]
    position = 13 + (3 * (1 << ((flags & 7) + 1)) if flags & 0x80 else 0)
    frames = 0
    while position < len(data):
        block = data[position]
        if block == 0x2C:  # image descriptor
            frames += 1
            if frames > 1:
                result['animated'] = True
                break
            if position + 10 > len(data):
                break
            local = data[position + 9]
            position += 10 + (3 * (1 << ((local & 7) + 1)) if local & 0x80 else 0)
            position = _skip_sub_blocks(data, position + 1)  # +1: LZW minimum code size
        elif block == 0x21:  # extension
            position = _skip_sub_blocks(data, position + 2)
        else:  # 0x3B trailer, or garbage
            break
        if position < 0:
            break
    if not result['width'] or not result['height']:
        raise Malformed('GIF without a size')
    return result


def _skip_sub_blocks(data, position):
    while position < len(data):
        size = data[position]
        position += 1 + size
        if size == 0:
            return position
    return -1
