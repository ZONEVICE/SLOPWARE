"""TIFF structure parsing: EXIF blocks, TIFF images and TIFF-based camera RAWs.

`parse(source)` takes a Source whose offset 0 is the TIFF header ("II*\\0" or
"MM\\0*"). For a JPEG that is the APP1 payload after "Exif\\0\\0"; for a TIFF or
a RAW file it is the file itself. Offsets inside TIFF are relative to that
header, which is why the caller hands over a window rather than raw bytes.

Only the tags Lurker shows or sorts by are decoded. MakerNotes and other large
blobs are skipped, and every IFD is visited at most once (a crafted file can
make IFDs point at each other).
"""
import calendar
import re
import struct

from .binary import Malformed

# (bytes per value, struct letter or None for raw bytes)
_TYPES = {
    1: (1, 'B'), 2: (1, None), 3: (2, 'H'), 4: (4, 'I'), 5: (8, 'R'), 6: (1, 'b'),
    7: (1, None), 8: (2, 'h'), 9: (4, 'i'), 10: (8, 'r'), 11: (4, 'f'), 12: (8, 'd'),
    13: (4, 'I'),
}
_MAX_ENTRIES = 512
_MAX_VALUE_BYTES = 64 * 1024
_MAX_IFDS = 32

# Tags
ORIENTATION = 0x0112
MAKE = 0x010F
MODEL = 0x0110
DATETIME = 0x0132
IMAGE_WIDTH = 0x0100
IMAGE_LENGTH = 0x0101
COMPRESSION = 0x0103
STRIP_OFFSETS = 0x0111
STRIP_BYTE_COUNTS = 0x0117
SUB_IFDS = 0x014A
JPEG_OFFSET = 0x0201
JPEG_LENGTH = 0x0202
EXIF_IFD = 0x8769
GPS_IFD = 0x8825
DATETIME_ORIGINAL = 0x9003
DATETIME_DIGITIZED = 0x9004
OFFSET_TIME_ORIGINAL = 0x9011
PIXEL_X = 0xA002
PIXEL_Y = 0xA003

_DETAIL_TAGS = {
    0x010E: 'description', 0x0131: 'software', 0x013B: 'artist', 0x8298: 'copyright',
    0x829A: 'exposureTime', 0x829D: 'fNumber', 0x8827: 'iso', 0x9204: 'exposureBias',
    0x9209: 'flash', 0x920A: 'focalLength', 0xA405: 'focalLength35mm', 0xA433: 'lensMake',
    0xA434: 'lensModel', 0x9011: 'offsetTime', 0xA420: 'uniqueId',
}

_DATE = re.compile(r'^\s*(\d{4})[:\-/](\d{2})[:\-/](\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?')


class _Tiff:
    def __init__(self, source):
        header = source.read(0, 8)
        if len(header) < 8:
            raise Malformed('no TIFF header')
        if header[:2] == b'II':
            self.order = '<'
        elif header[:2] == b'MM':
            self.order = '>'
        else:
            raise Malformed('bad byte order')
        magic = int.from_bytes(header[2:4], 'little' if self.order == '<' else 'big')
        # 42: TIFF. 0x4F52 ("RO"): Olympus ORF. 0x55: Panasonic RW2.
        if magic not in (42, 0x4F52, 0x5352, 0x55):
            raise Malformed('bad TIFF magic')
        self.source = source
        self.first = self.int(header, 4, 4)

    def int(self, data, offset, size, signed=False):
        return int.from_bytes(data[offset:offset + size], 'little' if self.order == '<' else 'big', signed=signed)

    def ifd(self, offset):
        """{tag: (type, count, raw value bytes)} and the next IFD's offset."""
        count_bytes = self.source.read(offset, 2)
        if len(count_bytes) < 2:
            raise Malformed('IFD outside the data')
        count = self.int(count_bytes, 0, 2)
        if count == 0 or count > _MAX_ENTRIES:
            raise Malformed('implausible IFD size')
        table = self.source.read(offset + 2, count * 12 + 4)
        entries = {}
        for index in range(min(count, len(table) // 12)):
            base = index * 12
            tag = self.int(table, base, 2)
            kind = self.int(table, base + 2, 2)
            number = self.int(table, base + 4, 4)
            if kind not in _TYPES:
                continue
            size = _TYPES[kind][0] * number
            if size <= 4:
                raw = table[base + 8:base + 8 + size]
            elif size <= _MAX_VALUE_BYTES:
                raw = self.source.read(self.int(table, base + 8, 4), size)
                if len(raw) < size:
                    continue
            else:
                raw = None  # too big to be anything we display (MakerNote, strips...)
            entries[tag] = (kind, number, raw)
        following = self.int(table, count * 12, 4) if len(table) >= count * 12 + 4 else 0
        return entries, following

    def values(self, entry):
        kind, number, raw = entry
        if raw is None:
            return []
        size, letter = _TYPES[kind]
        if letter is None:
            return raw
        if letter in 'Rr':
            signed = letter == 'r'
            return [(self.int(raw, i * 8, 4, signed), self.int(raw, i * 8 + 4, 4, signed)) for i in range(number)]
        if letter in 'fd':
            return list(struct.unpack(self.order + letter * number, raw))
        signed = letter in 'bhi'
        return [self.int(raw, i * size, size, signed) for i in range(number)]

    def first_int(self, entries, tag):
        entry = entries.get(tag)
        if entry is None or entry[0] not in (1, 3, 4, 6, 8, 9, 13):
            return None
        values = self.values(entry)
        return values[0] if values else None

    def text(self, entries, tag):
        entry = entries.get(tag)
        if entry is None or entry[0] not in (2, 7) or entry[2] is None:
            return None
        return entry[2].split(b'\x00', 1)[0].decode('utf-8', 'replace').strip() or None


def parse(source, detail=False, collect_jpegs=False):
    """Decode the interesting tags of a TIFF structure. Raises Malformed."""
    tiff = _Tiff(source)
    result = {}
    details = {}
    jpegs = []
    dimensions = []
    visited = set()

    def walk(offset, role):
        if not offset or offset in visited or len(visited) >= _MAX_IFDS:
            return None
        visited.add(offset)
        try:
            entries, following = tiff.ifd(offset)
        except Malformed:
            return None
        width = tiff.first_int(entries, IMAGE_WIDTH)
        height = tiff.first_int(entries, IMAGE_LENGTH)
        if width and height:
            dimensions.append((width, height, role))
        if collect_jpegs or role == 'ifd1':
            start = tiff.first_int(entries, JPEG_OFFSET)
            length = tiff.first_int(entries, JPEG_LENGTH)
            if start and length:
                jpegs.append((start, length, role))
            elif collect_jpegs and tiff.first_int(entries, COMPRESSION) in (6, 7):
                strips = tiff.values(entries[STRIP_OFFSETS]) if STRIP_OFFSETS in entries else []
                counts = tiff.values(entries[STRIP_BYTE_COUNTS]) if STRIP_BYTE_COUNTS in entries else []
                if len(strips) == 1 and len(counts) == 1 and counts[0]:
                    jpegs.append((strips[0], counts[0], role))
        return entries, following

    top = walk(tiff.first, 'ifd0')
    if top is None:
        raise Malformed('unreadable IFD0')
    ifd0, next_offset = top

    orientation = tiff.first_int(ifd0, ORIENTATION)
    if orientation and 1 <= orientation <= 8:
        result['orientation'] = orientation
    make = tiff.text(ifd0, MAKE)
    model = tiff.text(ifd0, MODEL)
    camera = camera_name(make, model)
    if camera:
        result['camera'] = camera
    fallback_date = parse_datetime(tiff.text(ifd0, DATETIME))

    if detail:
        for tag, name in _DETAIL_TAGS.items():
            if tag in ifd0:
                details[name] = _detail_value(tiff, ifd0[tag])
        if make:
            details['make'] = make
        if model:
            details['model'] = model

    # IFD1 (the thumbnail) and any further top-level IFDs.
    index = 1
    while next_offset and index < 8:
        found = walk(next_offset, 'ifd%d' % index)
        if found is None:
            break
        next_offset = found[1]
        index += 1

    if collect_jpegs and SUB_IFDS in ifd0:
        for offset in tiff.values(ifd0[SUB_IFDS])[:8]:
            walk(offset, 'sub')

    exif_offset = tiff.first_int(ifd0, EXIF_IFD)
    taken = None
    if exif_offset:
        found = walk(exif_offset, 'exif')
        if found:
            exif_entries = found[0]
            taken = parse_datetime(tiff.text(exif_entries, DATETIME_ORIGINAL)) or \
                parse_datetime(tiff.text(exif_entries, DATETIME_DIGITIZED))
            pixel_x = tiff.first_int(exif_entries, PIXEL_X)
            pixel_y = tiff.first_int(exif_entries, PIXEL_Y)
            if pixel_x and pixel_y:
                result['exifWidth'], result['exifHeight'] = pixel_x, pixel_y
            if detail:
                for tag, name in _DETAIL_TAGS.items():
                    if tag in exif_entries:
                        details[name] = _detail_value(tiff, exif_entries[tag])
    if taken or fallback_date:
        result['taken'] = taken or fallback_date

    if detail:
        gps_offset = tiff.first_int(ifd0, GPS_IFD)
        if gps_offset:
            found = walk(gps_offset, 'gps')
            if found:
                position = _gps(tiff, found[0])
                if position:
                    details.update(position)
        result['details'] = {key: value for key, value in details.items() if value not in (None, '', [])}

    ifd0_size = next((d for d in dimensions if d[2] == 'ifd0'), None)
    if ifd0_size:
        result['width'], result['height'] = ifd0_size[0], ifd0_size[1]
    if dimensions:
        largest = max(dimensions, key=lambda d: d[0] * d[1])
        result['largestWidth'], result['largestHeight'] = largest[0], largest[1]
    thumbnail = next(((start, length) for start, length, role in jpegs if role == 'ifd1'), None)
    if thumbnail:
        result['thumbnail'] = thumbnail
    if collect_jpegs:
        result['jpegs'] = [(start, length) for start, length, _ in jpegs]
    return result


def camera_name(make, model):
    """'Canon' + 'Canon EOS 5D' -> 'Canon EOS 5D'; 'NIKON CORPORATION' + 'NIKON D750' -> 'NIKON D750'."""
    make = (make or '').strip()
    model = (model or '').strip()
    if not model:
        return make or None
    first_word = make.split(' ')[0].lower() if make else ''
    if not make or (first_word and model.lower().startswith(first_word)):
        return model
    return '%s %s' % (make, model)


def parse_datetime(text):
    """EXIF 'YYYY:MM:DD HH:MM:SS' -> seconds as if it were UTC (a wall-clock time).

    EXIF times carry no time zone, so they are kept as the wall-clock time the
    camera showed: a photo taken at 23:30 stays on that day wherever it is
    viewed. The client treats the value as a floating local time.
    """
    if not text:
        return None
    match = _DATE.match(text)
    if not match:
        return None
    year, month, day, hour, minute = (int(match.group(i)) for i in range(1, 6))
    second = int(match.group(6) or 0)
    if not (1900 < year < 2200 and 1 <= month <= 12 and 1 <= day <= 31 and hour < 24 and minute < 60 and second < 61):
        return None
    try:
        return calendar.timegm((year, month, day, hour, minute, min(second, 59), 0, 0, 0))
    except (ValueError, OverflowError):
        return None


def _detail_value(tiff, entry):
    kind = entry[0]
    if kind in (2, 7):
        raw = entry[2]
        if raw is None or kind == 7 and len(raw) > 64:
            return None
        return raw.split(b'\x00', 1)[0].decode('utf-8', 'replace').strip() or None
    values = tiff.values(entry)
    if not values:
        return None
    value = values[0]
    if isinstance(value, tuple):
        numerator, denominator = value
        if not denominator:
            return None
        return [numerator, denominator]
    return value


def _gps(tiff, entries):
    def coordinate(value_tag, ref_tag):
        if value_tag not in entries:
            return None
        parts = tiff.values(entries[value_tag])
        if len(parts) != 3 or any(den == 0 for _, den in parts):
            return None
        degrees = parts[0][0] / parts[0][1] + parts[1][0] / parts[1][1] / 60 + parts[2][0] / parts[2][1] / 3600
        reference = tiff.text(entries, ref_tag) or ''
        return -degrees if reference.upper() in ('S', 'W') else degrees

    latitude = coordinate(2, 1)
    longitude = coordinate(4, 3)
    if latitude is None or longitude is None or (latitude == 0 and longitude == 0):
        return None
    position = {'latitude': round(latitude, 6), 'longitude': round(longitude, 6)}
    if 6 in entries:
        altitude = tiff.values(entries[6])
        if altitude and altitude[0][1]:
            sign = -1 if tiff.first_int(entries, 5) == 1 else 1
            position['altitude'] = round(sign * altitude[0][0] / altitude[0][1], 1)
    return position


def orientation_segment(orientation):
    """A minimal APP1 EXIF segment holding only an Orientation tag.

    Embedded thumbnails carry no orientation of their own; inserting this
    after their SOI makes browsers rotate them like the full image.
    """
    tiff = (b'MM\x00\x2a' + (8).to_bytes(4, 'big') + (1).to_bytes(2, 'big')
            + ORIENTATION.to_bytes(2, 'big') + (3).to_bytes(2, 'big') + (1).to_bytes(4, 'big')
            + orientation.to_bytes(2, 'big') + b'\x00\x00' + (0).to_bytes(4, 'big'))
    payload = b'Exif\x00\x00' + tiff
    return b'\xff\xe1' + (len(payload) + 2).to_bytes(2, 'big') + payload
