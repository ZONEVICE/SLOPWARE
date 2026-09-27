"""Matroska and WebM: duration, date and the video track's size and codec.

EBML elements are (ID, size, data), with both ID and size written as
variable-length integers. The interesting elements (Info, Tracks) normally
precede the first Cluster; when they do not, the SeekHead says where they are.
"""
import struct

from ..binary import Malformed

_EBML = 0x1A45DFA3
_SEGMENT = 0x18538067
_SEEK_HEAD = 0x114D9B74
_SEEK = 0x4DBB
_SEEK_ID = 0x53AB
_SEEK_POSITION = 0x53AC
_INFO = 0x1549A966
_TIMECODE_SCALE = 0x2AD7B1
_DURATION = 0x4489
_DATE_UTC = 0x4461
_TRACKS = 0x1654AE6B
_TRACK_ENTRY = 0xAE
_TRACK_TYPE = 0x83
_CODEC_ID = 0x86
_VIDEO = 0xE0
_PIXEL_WIDTH = 0xB0
_PIXEL_HEIGHT = 0xBA
_DISPLAY_WIDTH = 0x54B0
_DISPLAY_HEIGHT = 0x54BA
_CLUSTER = 0x1F43B675
_MATROSKA_EPOCH = 978307200  # 2001-01-01T00:00:00Z as Unix time

_CODECS = {'V_VP8': 'vp8', 'V_VP9': 'vp9', 'V_AV1': 'av1', 'V_MPEG4/ISO/AVC': 'h264',
           'V_MPEGH/ISO/HEVC': 'hevc', 'V_THEORA': 'theora', 'V_MPEG4/ISO/ASP': 'mpeg4'}


def _header(source, position):
    """(element id, data size or None if unknown, header length)."""
    data = source.read(position, 12)
    if not data:
        raise Malformed('EOF')
    first = data[0]
    id_length = 1
    while id_length <= 4 and not first & (0x80 >> (id_length - 1)):
        id_length += 1
    if id_length > 4 or len(data) < id_length + 1:
        raise Malformed('bad element id')
    element = int.from_bytes(data[:id_length], 'big')
    marker = data[id_length]
    size_length = 1
    while size_length <= 8 and not marker & (0x80 >> (size_length - 1)):
        size_length += 1
    if size_length > 8 or len(data) < id_length + size_length:
        raise Malformed('bad element size')
    size = int.from_bytes(data[id_length:id_length + size_length], 'big') & ((1 << (7 * size_length)) - 1)
    if size == (1 << (7 * size_length)) - 1:
        size = None  # "unknown size" (live streams)
    return element, size, id_length + size_length


def _children(source, start, end, limit=512):
    position = start
    count = 0
    while position < end and count < limit:
        element, size, header = _header(source, position)
        data = position + header
        yield element, data, size
        if size is None:
            return
        position = data + size
        count += 1


def _uint(source, position, size):
    return int.from_bytes(source.read(position, min(size, 8)), 'big')


def read(source, detail=False):
    element, size, header = _header(source, 0)
    if element != _EBML or size is None:
        raise Malformed('not EBML')
    position = header + size
    element, segment_size, header = _header(source, position)
    if element != _SEGMENT:
        raise Malformed('no Segment')
    segment_start = position + header
    segment_end = source.size if segment_size is None else min(source.size, segment_start + segment_size)

    info = tracks = None
    seeks = {}
    for element, data, size in _children(source, segment_start, segment_end):
        if size is None:
            break
        if element == _SEEK_HEAD:
            seeks.update(_read_seek_head(source, data, data + size, segment_start))
        elif element == _INFO:
            info = (data, data + size)
        elif element == _TRACKS:
            tracks = (data, data + size)
        elif element == _CLUSTER:
            break
        if info and tracks:
            break
    for wanted, name in ((_INFO, 'info'), (_TRACKS, 'tracks')):
        if (info if name == 'info' else tracks) is None and wanted in seeks:
            try:
                found, size, header = _header(source, seeks[wanted])
            except Malformed:
                continue
            if found == wanted and size is not None:
                span = (seeks[wanted] + header, seeks[wanted] + header + size)
                if name == 'info':
                    info = span
                else:
                    tracks = span

    result = {}
    if info:
        _read_info(source, info, result)
    if tracks:
        _read_tracks(source, tracks, result)
    return result


def _read_seek_head(source, start, end, segment_start):
    found = {}
    for element, data, size in _children(source, start, end):
        if element != _SEEK or size is None:
            continue
        target = offset = None
        for inner, inner_data, inner_size in _children(source, data, data + size):
            if inner == _SEEK_ID and inner_size:
                target = int.from_bytes(source.read(inner_data, min(inner_size, 4)), 'big')
            elif inner == _SEEK_POSITION and inner_size:
                offset = _uint(source, inner_data, inner_size)
        if target is not None and offset is not None:
            found[target] = segment_start + offset
    return found


def _read_info(source, span, result):
    scale = 1000000
    duration = None
    for element, data, size in _children(source, *span):
        if size is None:
            break
        if element == _TIMECODE_SCALE:
            scale = _uint(source, data, size) or scale
        elif element == _DURATION and size in (4, 8):
            raw = source.read(data, size)
            if len(raw) == size:
                duration = struct.unpack('>f' if size == 4 else '>d', raw)[0]
        elif element == _DATE_UTC and size == 8:
            nanoseconds = int.from_bytes(source.read(data, 8), 'big', signed=True)
            moment = _MATROSKA_EPOCH + nanoseconds / 1e9
            if moment > 365 * 86400:
                result['taken'] = int(moment)
                result['takenUtc'] = True
    if duration and duration > 0:
        result['duration'] = duration * scale / 1e9


def _read_tracks(source, span, result):
    for element, data, size in _children(source, *span):
        if element != _TRACK_ENTRY or size is None:
            continue
        track_type = codec = None
        width = height = None
        for inner, inner_data, inner_size in _children(source, data, data + size):
            if inner_size is None:
                break
            if inner == _TRACK_TYPE:
                track_type = _uint(source, inner_data, inner_size)
            elif inner == _CODEC_ID:
                codec = source.read(inner_data, min(inner_size, 64)).rstrip(b'\x00').decode('ascii', 'replace')
            elif inner == _VIDEO:
                display = {}
                for video, video_data, video_size in _children(source, inner_data, inner_data + inner_size):
                    if video_size is None:
                        break
                    if video in (_PIXEL_WIDTH, _PIXEL_HEIGHT, _DISPLAY_WIDTH, _DISPLAY_HEIGHT):
                        display[video] = _uint(source, video_data, video_size)
                width = display.get(_PIXEL_WIDTH)
                height = display.get(_PIXEL_HEIGHT)
        if track_type == 1 and width and height:
            result['width'], result['height'] = width, height
            if codec:
                result['codec'] = _CODECS.get(codec, codec.lower().replace('v_', ''))
            return
