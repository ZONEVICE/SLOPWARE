"""AVI (RIFF): size, duration and codec from the header list, and MPEG-TS sniffing."""
from ..binary import Malformed, u32le


def read_avi(source, detail=False):
    header = source.read(0, 12)
    if len(header) < 12 or header[:4] != b'RIFF' or header[8:12] != b'AVI ':
        raise Malformed('not an AVI')
    result = {}
    hdrl = _find_list(source, 12, source.size, b'hdrl')
    if not hdrl:
        return result
    start, end = hdrl
    frames = rate_duration = None
    microseconds = 0
    for fourcc, data, size in _chunks(source, start, end):
        if fourcc == b'avih' and size >= 40:
            avih = source.read(data, 40)
            microseconds = u32le(avih, 0)
            frames = u32le(avih, 16)
            width, height = u32le(avih, 32), u32le(avih, 36)
            if width and height:
                result['width'], result['height'] = width, height
        elif fourcc == b'LIST':
            kind = source.read(data, 4)
            if kind == b'strl':
                stream = _read_stream(source, data + 4, data + size)
                if stream.get('video'):
                    if stream.get('duration'):
                        rate_duration = stream['duration']
                    if stream.get('codec'):
                        result['codec'] = stream['codec']
            elif kind == b'odml':
                for inner, inner_data, inner_size in _chunks(source, data + 4, data + size):
                    if inner == b'dmlh' and inner_size >= 4:
                        frames = max(frames or 0, u32le(source.read(inner_data, 4), 0))
    if rate_duration:
        result['duration'] = rate_duration
    elif frames and microseconds:
        result['duration'] = frames * microseconds / 1e6
    return result


def _read_stream(source, start, end):
    stream = {}
    for fourcc, data, size in _chunks(source, start, end):
        if fourcc == b'strh' and size >= 36:
            strh = source.read(data, 36)
            stream['video'] = strh[:4] == b'vids'
            scale, rate, length = u32le(strh, 20), u32le(strh, 24), u32le(strh, 32)
            if scale and rate and length:
                stream['duration'] = length * scale / rate
        elif fourcc == b'strf' and stream.get('video') and size >= 20:
            compression = source.read(data + 16, 4)
            if compression.strip(b'\x00').isalnum():
                stream['codec'] = compression.decode('ascii').strip().lower()
    return stream


def _chunks(source, start, end, limit=256):
    position = start
    count = 0
    while position + 8 <= end and count < limit:
        head = source.read(position, 8)
        if len(head) < 8:
            return
        size = u32le(head, 4)
        yield head[:4], position + 8, size
        position += 8 + size + (size & 1)
        count += 1


def _find_list(source, start, end, kind):
    for fourcc, data, size in _chunks(source, start, end):
        if fourcc == b'LIST' and source.read(data, 4) == kind:
            return data + 4, min(end, data + size)
    return None


def is_transport_stream(head):
    """True for MPEG-TS (188-byte packets) or M2TS (192-byte packets) content."""
    if len(head) >= 377 and head[0] == 0x47 and head[188] == 0x47 and head[376] == 0x47:
        return True
    return len(head) >= 389 and head[4] == 0x47 and head[196] == 0x47 and head[388] == 0x47


def read_ts(source, detail=False):
    if not is_transport_stream(source.read(0, 400)):
        raise Malformed('not a transport stream')
    return {}
