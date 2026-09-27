"""ISO base media files: MP4, MOV, 3GP, M4V videos and HEIF/HEIC/AVIF images.

Only box headers are read on the way down; the sample tables and the media
data (often gigabytes) are skipped by size. A movie needs moov/mvhd (duration,
creation time) and the video track's tkhd (size, rotation matrix) and stsd
(codec). A HEIF image needs the primary item's ispe (size) and irot
(rotation) properties, plus the Exif item for the date the photo was taken.
"""
import math
import time

from .. import exif
from ..binary import BytesSource, Malformed, s32be, u16be, u32be, u64be

_MAC_EPOCH_OFFSET = 2082844800  # seconds from 1904-01-01 to 1970-01-01
_IMAGE_BRANDS = {b'heic', b'heix', b'heim', b'heis', b'mif1', b'mif2', b'avif', b'avio', b'jpeg'}
_MAX_BOXES = 4096


def boxes(source, start, end):
    """Yield (type, box_start, payload_start, box_end) for the boxes in [start, end)."""
    position = start
    count = 0
    while position + 8 <= end and count < _MAX_BOXES:
        head = source.read(position, 16)
        if len(head) < 8:
            return
        size = u32be(head, 0)
        kind = head[4:8]
        header = 8
        if size == 1:
            if len(head) < 16:
                return
            size = u64be(head, 8)
            header = 16
        elif size == 0:
            size = end - position
        if size < header:
            return
        yield kind, position, position + header, min(position + size, end)
        position += size
        count += 1


def _find(source, start, end, kind):
    for found, box_start, payload, box_end in boxes(source, start, end):
        if found == kind:
            return payload, box_end
    return None


def read(source, detail=False):
    brands = set()
    has_moov = has_meta = False
    moov = meta = last_fragment = None
    for kind, _, payload, box_end in boxes(source, 0, source.size):
        if kind == b'ftyp':
            data = source.read(payload, min(box_end - payload, 256))
            if len(data) >= 8:
                brands.add(data[:4])
                brands.update(data[index:index + 4] for index in range(8, len(data) - 3, 4))
        elif kind == b'moov':
            has_moov, moov = True, (payload, box_end)
        elif kind == b'meta':
            has_meta, meta = True, (payload + 4, box_end)  # FullBox: skip version and flags
        elif kind == b'moof':
            last_fragment = (payload, box_end)
        if has_moov and has_meta:
            break
    if not brands and not has_moov:
        raise Malformed('not an ISO media file')
    if has_meta and (brands & _IMAGE_BRANDS or not has_moov):
        result = _read_heif(source, meta, detail)
        if result.get('width'):
            return result
    if has_moov:
        return _read_movie(source, moov, last_fragment)
    return {}


# --- Movies -----------------------------------------------------------------

def _read_movie(source, moov, last_fragment=None):
    start, end = moov
    result = {}
    timescale = duration = 0
    tracks = []
    default_durations = {}
    for kind, _, payload, box_end in boxes(source, start, end):
        if kind == b'mvhd':
            data = source.read(payload, 32)
            if len(data) < 20:
                continue
            if data[0] == 1:
                created, timescale, duration = u64be(data, 4), u32be(data, 20), u64be(data, 24) if len(data) >= 32 else 0
            else:
                created, timescale, duration = u32be(data, 4), u32be(data, 12), u32be(data, 16)
            moment = _mac_time(created)
            if moment:
                result['taken'] = moment
                result['takenUtc'] = True
        elif kind == b'trak':
            track = _read_track(source, payload, box_end)
            if track:
                tracks.append(track)
        elif kind == b'mvex':
            for inner, _, inner_payload, _ in boxes(source, payload, box_end):
                data = source.read(inner_payload, 16)
                if inner == b'mehd' and not duration and len(data) >= 8:
                    duration = u64be(data, 4) if data[0] == 1 and len(data) >= 12 else u32be(data, 4)
                elif inner == b'trex' and len(data) >= 16:
                    default_durations[u32be(data, 4)] = u32be(data, 12)
    if timescale and duration and duration != 0xFFFFFFFF:
        result['duration'] = duration / timescale
    video = [track for track in tracks if track.get('handler') == b'vide']
    if not result.get('duration'):
        durations = [track['duration'] for track in tracks if track.get('duration')]
        if durations:
            result['duration'] = max(durations)
    if not result.get('duration') and last_fragment:
        # Fragmented MP4 (screen recorders, MediaRecorder, DASH) with no total:
        # the last fragment's start time plus its own length is the duration.
        ends = _fragment_ends(source, last_fragment, default_durations)
        seconds = [ends[track['id']] / track['timescale'] for track in tracks
                   if track.get('id') in ends and track.get('timescale')]
        if seconds:
            result['duration'] = max(seconds)
    if video:
        best = max(video, key=lambda track: track.get('width', 0) * track.get('height', 0))
        for key in ('width', 'height', 'rotation', 'codec'):
            if best.get(key):
                result[key] = best[key]
    elif tracks and all(track.get('handler') == b'soun' for track in tracks):
        result['audioOnly'] = True
    return result


def _read_track(source, start, end):
    track = {}
    for kind, _, payload, box_end in boxes(source, start, end):
        if kind == b'tkhd':
            data = source.read(payload, 96)
            if not data:
                continue
            base = 52 if data[0] == 1 else 40  # where the matrix starts
            if len(data) < base + 44:
                continue
            matrix_a, matrix_b = s32be(data, base) / 65536, s32be(data, base + 4) / 65536
            angle = round(math.degrees(math.atan2(matrix_b, matrix_a)) / 90) * 90 % 360
            if angle:
                track['rotation'] = angle
            track['id'] = u32be(data, 20 if data[0] == 1 else 12)
            width, height = u32be(data, base + 36) >> 16, u32be(data, base + 40) >> 16
            if width and height:
                track['width'], track['height'] = width, height
        elif kind == b'mdia':
            for inner, _, inner_payload, inner_end in boxes(source, payload, box_end):
                if inner == b'hdlr':
                    data = source.read(inner_payload, 12)
                    if len(data) == 12:
                        track['handler'] = data[8:12]
                elif inner == b'mdhd':
                    data = source.read(inner_payload, 32)
                    if len(data) >= 20:
                        if data[0] == 1 and len(data) >= 32:
                            scale, length = u32be(data, 20), u64be(data, 24)
                        else:
                            scale, length = u32be(data, 12), u32be(data, 16)
                        if scale:
                            track['timescale'] = scale
                        if scale and length and length != 0xFFFFFFFF:
                            track['duration'] = length / scale
                elif inner == b'minf':
                    _read_sample_description(source, inner_payload, inner_end, track)
    return track


def _fragment_ends(source, fragment, default_durations):
    """{track id: end time in track units} for one movie fragment (moof)."""
    ends = {}
    for kind, _, payload, box_end in boxes(source, *fragment):
        if kind != b'traf':
            continue
        track_id = base = None
        default = 0
        total = 0
        for inner, _, inner_payload, inner_end in boxes(source, payload, box_end):
            data = source.read(inner_payload, min(inner_end - inner_payload, 1 << 20))
            if inner == b'tfhd' and len(data) >= 8:
                flags = int.from_bytes(data[1:4], 'big')
                track_id = u32be(data, 4)
                position = 8 + (8 if flags & 0x01 else 0) + (4 if flags & 0x02 else 0)
                default = default_durations.get(track_id, 0)
                if flags & 0x08 and len(data) >= position + 4:
                    default = u32be(data, position)
            elif inner == b'tfdt' and len(data) >= 8:
                base = u64be(data, 4) if data[0] == 1 and len(data) >= 12 else u32be(data, 4)
            elif inner == b'trun' and len(data) >= 8:
                flags = int.from_bytes(data[1:4], 'big')
                count = u32be(data, 4)
                position = 8 + (4 if flags & 0x01 else 0) + (4 if flags & 0x04 else 0)
                if not flags & 0x100:
                    total += count * default
                    continue
                stride = 4 * sum(1 for bit in (0x100, 0x200, 0x400, 0x800) if flags & bit)
                for index in range(min(count, (len(data) - position) // stride)):
                    total += u32be(data, position + index * stride)
        if track_id is not None and base is not None:
            ends[track_id] = base + total
    return ends


def _read_sample_description(source, start, end, track):
    stbl = _find(source, start, end, b'stbl')
    if not stbl:
        return
    stsd = _find(source, stbl[0], stbl[1], b'stsd')
    if not stsd:
        return
    data = source.read(stsd[0], 8 + 8 + 28)
    if len(data) < 16:
        return
    codec = data[12:16]
    if codec.isalnum() or codec in (b'mp4v', b'avc1'):
        track['codec'] = codec.decode('ascii', 'replace').strip()
    if len(data) >= 44 and not track.get('width'):
        width, height = u16be(data, 16 + 24), u16be(data, 16 + 26)
        if width and height:
            track['width'], track['height'] = width, height


def _mac_time(value):
    """Seconds since 1904 (UTC) -> Unix time, or None for an unset or absurd value."""
    if not value:
        return None
    unix = value - _MAC_EPOCH_OFFSET
    if unix < 365 * 86400 or unix > time.time() + 366 * 86400:
        return None
    return unix


# --- HEIF / AVIF --------------------------------------------------------------

def _read_heif(source, meta, detail):
    start, end = meta
    primary = None
    properties = []
    associations = {}
    exif_item = None
    locations = {}
    for kind, _, payload, box_end in boxes(source, start, end):
        if kind == b'pitm':
            data = source.read(payload, 8)
            if len(data) >= 6:
                primary = u16be(data, 4) if data[0] == 0 else u32be(data, 4)
        elif kind == b'iprp':
            for inner, _, inner_payload, inner_end in boxes(source, payload, box_end):
                if inner == b'ipco':
                    properties = [(prop, prop_payload, prop_end)
                                  for prop, _, prop_payload, prop_end in boxes(source, inner_payload, inner_end)]
                elif inner == b'ipma':
                    associations.update(_read_ipma(source, inner_payload, inner_end))
        elif kind == b'iinf':
            exif_item = _find_exif_item(source, payload, box_end)
        elif kind == b'iloc':
            locations = _read_iloc(source, payload, box_end)

    result = {}
    wanted = associations.get(primary) if primary is not None else None
    chosen = [properties[index - 1] for index in wanted if 0 < index <= len(properties)] if wanted else properties
    sizes = []
    for kind, payload, _ in chosen:
        if kind == b'ispe':
            data = source.read(payload, 12)
            if len(data) == 12:
                sizes.append((u32be(data, 4), u32be(data, 8)))
        elif kind == b'irot' and wanted:
            data = source.read(payload, 1)
            if data:
                # irot is counter-clockwise; store the clockwise angle a viewer applies.
                angle = (data[0] & 3) * 90
                if angle:
                    result['rotation'] = (360 - angle) % 360
    if sizes:
        width, height = max(sizes, key=lambda size: size[0] * size[1])
        result['width'], result['height'] = width, height

    if exif_item is not None and exif_item in locations:
        offset, length = locations[exif_item]
        data = source.read(offset, min(length, 1 << 20))
        if len(data) > 4:
            skip = u32be(data, 0) + 4
            try:
                info = exif.parse(BytesSource(data, skip), detail=detail)
            except Malformed:
                info = {}
            # HEIF orientation lives in irot; EXIF orientation must be ignored.
            for key in ('taken', 'camera', 'details'):
                if key in info:
                    result[key] = info[key]
    return result


def _read_ipma(source, start, end):
    data = source.read(start, min(end - start, 1 << 20))
    if len(data) < 8:
        return {}
    version, flags = data[0], int.from_bytes(data[1:4], 'big')
    count = u32be(data, 4)
    position = 8
    result = {}
    for _ in range(min(count, 100000)):
        if version < 1:
            if position + 3 > len(data):
                break
            item = u16be(data, position)
            position += 2
        else:
            if position + 5 > len(data):
                break
            item = u32be(data, position)
            position += 4
        number = data[position]
        position += 1
        indexes = []
        for _ in range(number):
            if flags & 1:
                if position + 2 > len(data):
                    break
                indexes.append(u16be(data, position) & 0x7FFF)
                position += 2
            else:
                if position + 1 > len(data):
                    break
                indexes.append(data[position] & 0x7F)
                position += 1
        result[item] = indexes
    return result


def _find_exif_item(source, start, end):
    data = source.read(start, 8)
    if len(data) < 6:
        return None
    first = start + (6 if data[0] == 0 else 8)
    for kind, _, payload, _ in boxes(source, first, end):
        if kind != b'infe':
            continue
        info = source.read(payload, 16)
        if len(info) >= 12 and info[0] == 2:
            item, item_type = u16be(info, 4), info[8:12]
        elif len(info) >= 14 and info[0] >= 3:
            item, item_type = u32be(info, 4), info[10:14]
        else:
            continue
        if item_type == b'Exif':
            return item
    return None


def _read_iloc(source, start, end):
    data = source.read(start, min(end - start, 1 << 20))
    if len(data) < 8:
        return {}
    version = data[0]
    offset_size, length_size = data[4] >> 4, data[4] & 15
    base_size, index_size = data[5] >> 4, (data[5] & 15) if version in (1, 2) else 0
    position = 6
    if version < 2:
        count = u16be(data, position)
        position += 2
    else:
        count = u32be(data, position)
        position += 4

    def number(size):
        nonlocal position
        if size == 0:
            return 0
        if position + size > len(data):
            raise Malformed('iloc truncated')
        value = int.from_bytes(data[position:position + size], 'big')
        position += size
        return value

    locations = {}
    try:
        for _ in range(min(count, 100000)):
            item = number(4 if version == 2 else 2)
            method = number(2) & 15 if version in (1, 2) else 0
            number(2)  # data_reference_index
            base = number(base_size)
            extents = number(2)
            first = None
            for _ in range(extents):
                if index_size:
                    number(index_size)
                extent_offset = number(offset_size)
                extent_length = number(length_size)
                if first is None:
                    first = (base + extent_offset, extent_length)
            if method == 0 and first is not None:
                locations[item] = first
    except Malformed:
        pass
    return locations
