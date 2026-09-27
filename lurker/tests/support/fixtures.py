"""Media files built byte by byte, so the tests need no image tool or sample.

* `jpeg()` is a real baseline JPEG encoder, limited to images made of solid
  8x8 blocks: only DC coefficients are coded, which keeps it tiny while
  browsers decode the result like any photo. It can embed an EXIF block with
  orientation, dates, camera and a thumbnail.
* `png()`, `gif()` and `bmp()` produce real, decodable images too.
* The container builders (MP4, HEIF, Matroska, AVI, TIFF/RAW, WebP) produce
  structurally valid headers for the metadata readers; they are not playable.
* TINY_WEBM is a real 64x48, 1.5 s VP8 video (made once with ffmpeg) for the
  browser tests.
"""
import base64
import os
import struct
import zlib

# --- JPEG ---------------------------------------------------------------------------

# Standard luminance DC table (ITU T.81 Annex K): categories 0..11.
_DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
_DC_VALUES = list(range(12))
# The smallest valid AC table: end-of-block ("0") and zero-run ("10").
_AC_BITS = [1, 1] + [0] * 14
_AC_VALUES = [0x00, 0xF0]


def _canonical_codes(bits, values):
    codes = {}
    code = 0
    index = 0
    for length in range(1, 17):
        for _ in range(bits[length - 1]):
            codes[values[index]] = (code, length)
            code += 1
            index += 1
        code <<= 1
    return codes


_DC_CODES = _canonical_codes(_DC_BITS, _DC_VALUES)
_AC_CODES = _canonical_codes(_AC_BITS, _AC_VALUES)


class _BitWriter:
    def __init__(self):
        self.out = bytearray()
        self.accumulator = 0
        self.count = 0

    def write(self, value, length):
        for shift in range(length - 1, -1, -1):
            self.accumulator = (self.accumulator << 1) | ((value >> shift) & 1)
            self.count += 1
            if self.count == 8:
                self.out.append(self.accumulator)
                if self.accumulator == 0xFF:
                    self.out.append(0x00)  # byte stuffing
                self.accumulator = 0
                self.count = 0

    def flush(self):
        if self.count:
            self.write((1 << (8 - self.count)) - 1, 8 - self.count)  # pad with ones
        return bytes(self.out)


def _segment(marker, payload):
    return bytes([0xFF, marker]) + struct.pack('>H', len(payload) + 2) + payload


def _ycbcr(rgb):
    r, g, b = rgb
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    return [max(0, min(255, round(v))) for v in (y, cb, cr)]


def jpeg(width, height, color=(200, 80, 40), blocks=None, exif=None, jfif=True):
    """A baseline JPEG of solid 8x8 blocks.

    `blocks(bx, by)` may return the RGB colour of each block; otherwise the
    whole image is `color`. `exif` is an APP1 segment from `exif_segment()`.
    """
    quant = bytes([0]) + bytes([1] * 64)  # table 0, 8-bit precision, all ones
    frame = struct.pack('>BHHB', 8, height, width, 3) + bytes([1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0])
    huffman = (bytes([0x00]) + bytes(_DC_BITS) + bytes(_DC_VALUES)
               + bytes([0x10]) + bytes(_AC_BITS) + bytes(_AC_VALUES))
    scan_header = bytes([3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0])
    writer = _BitWriter()
    previous = [0, 0, 0]
    eob_code, eob_length = _AC_CODES[0x00]
    for by in range((height + 7) // 8):
        for bx in range((width + 7) // 8):
            components = _ycbcr(blocks(bx, by) if blocks else color)
            for index, value in enumerate(components):
                dc = 8 * (value - 128)
                diff = dc - previous[index]
                previous[index] = dc
                size = abs(diff).bit_length()
                code, length = _DC_CODES[size]
                writer.write(code, length)
                if size:
                    writer.write(diff if diff > 0 else diff + (1 << size) - 1, size)
                writer.write(eob_code, eob_length)
    parts = [b'\xff\xd8']
    if exif:
        parts.append(exif)
    elif jfif:
        parts.append(_segment(0xE0, b'JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00'))
    parts += [_segment(0xDB, quant), _segment(0xC0, frame), _segment(0xC4, huffman),
              _segment(0xDA, scan_header), writer.flush(), b'\xff\xd9']
    return b''.join(parts)


# --- TIFF / EXIF ----------------------------------------------------------------------

ASCII, SHORT, LONG, RATIONAL = 2, 3, 4, 5


def _value_bytes(kind, value, order):
    if kind == ASCII:
        return value.encode('ascii') + b'\x00', len(value) + 1
    if kind == SHORT:
        values = value if isinstance(value, (list, tuple)) else [value]
        return b''.join(struct.pack(order + 'H', v) for v in values), len(values)
    if kind == LONG:
        values = value if isinstance(value, (list, tuple)) else [value]
        return b''.join(struct.pack(order + 'I', v) for v in values), len(values)
    if kind == RATIONAL:
        values = value if isinstance(value[0], (list, tuple)) else [value]
        return b''.join(struct.pack(order + 'II', n, d) for n, d in values), len(values)
    raise ValueError(kind)


def tiff_structure(ifds, order='>', blobs=()):
    """Serialize IFDs into a TIFF structure (header at offset 0).

    `ifds` is a list of (name, [(tag, type, value)]) in file order; a value
    may be ('ifd', name) or ('blob', name) to point at another IFD or at one
    of `blobs` [(name, bytes)]. The first IFD is IFD0; an IFD named 'ifd1'
    is chained after IFD0.
    """
    header = (b'II*\x00' if order == '<' else b'MM\x00*')
    layout = {}
    position = 8
    serialized = []
    # First pass: sizes.
    for name, entries in ifds:
        size = 2 + 12 * len(entries) + 4
        extra = 0
        for tag, kind, value in entries:
            if isinstance(value, tuple) and value and value[0] in ('ifd', 'blob'):
                continue
            data, _ = _value_bytes(kind, value, order)
            if len(data) > 4:
                extra += len(data) + (len(data) & 1)
        layout[name] = position
        position += size + extra
    for name, data in blobs:
        layout[name] = position
        position += len(data)
    # Second pass: bytes.
    for name, entries in ifds:
        start = layout[name]
        values_at = start + 2 + 12 * len(entries) + 4
        table = struct.pack(order + 'H', len(entries))
        extra = b''
        for tag, kind, value in sorted(entries, key=lambda entry: entry[0]):
            if isinstance(value, tuple) and value and value[0] in ('ifd', 'blob'):
                data, count = struct.pack(order + 'I', layout[value[1]]), 1
                if value[0] == 'blob' and tag in (0x0202, 0x0117):  # a length tag: the blob's size
                    data = struct.pack(order + 'I', len(dict(blobs)[value[1]]))
            else:
                data, count = _value_bytes(kind, value, order)
            if len(data) <= 4:
                table += struct.pack(order + 'HHI', tag, kind, count) + data.ljust(4, b'\x00')
            else:
                table += struct.pack(order + 'HHII', tag, kind, count, values_at + len(extra))
                extra += data + (b'\x00' if len(data) & 1 else b'')
        following = layout['ifd1'] if name == 'ifd0' and 'ifd1' in layout else 0
        table += struct.pack(order + 'I', following)
        serialized.append(table + extra)
    body = header + struct.pack(order + 'I', 8) + b''.join(serialized) + b''.join(data for _, data in blobs)
    return body


def exif_tiff(orientation=None, make=None, model=None, taken=None, digitized=None, modified=None,
              thumbnail=None, gps=None, exposure=None, order='>', width=None, height=None):
    ifd0 = []
    if make:
        ifd0.append((0x010F, ASCII, make))
    if model:
        ifd0.append((0x0110, ASCII, model))
    if orientation:
        ifd0.append((0x0112, SHORT, orientation))
    if modified:
        ifd0.append((0x0132, ASCII, modified))
    if width:
        ifd0 += [(0x0100, LONG, width), (0x0101, LONG, height)]
    ifds = [('ifd0', ifd0)]
    exif_entries = []
    if taken:
        exif_entries.append((0x9003, ASCII, taken))
    if digitized:
        exif_entries.append((0x9004, ASCII, digitized))
    if exposure:
        exif_entries += [(0x829A, RATIONAL, exposure['time']), (0x829D, RATIONAL, exposure['f']),
                         (0x8827, SHORT, exposure['iso'])]
    if exif_entries:
        ifd0.append((0x8769, LONG, ('ifd', 'exif')))
        ifds.append(('exif', exif_entries))
    if gps:
        ifd0.append((0x8825, LONG, ('ifd', 'gps')))
        lat, lon = gps

        def dms(value):
            value = abs(value)
            degrees = int(value)
            minutes = int((value - degrees) * 60)
            seconds = round(((value - degrees) * 60 - minutes) * 60 * 1000)
            return [(degrees, 1), (minutes, 1), (seconds, 1000)]

        ifds.append(('gps', [(1, ASCII, 'N' if lat >= 0 else 'S'), (2, RATIONAL, dms(lat)),
                             (3, ASCII, 'E' if lon >= 0 else 'W'), (4, RATIONAL, dms(lon))]))
    blobs = []
    if thumbnail:
        ifds.append(('ifd1', [(0x0103, SHORT, 6), (0x0201, LONG, ('blob', 'thumb')),
                              (0x0202, LONG, ('blob', 'thumb'))]))
        blobs.append(('thumb', thumbnail))
    return tiff_structure(ifds, order, blobs)


def exif_segment(**fields):
    payload = b'Exif\x00\x00' + exif_tiff(**fields)
    return b'\xff\xe1' + struct.pack('>H', len(payload) + 2) + payload


def raw_file(preview, thumbnail=None, orientation=None, make='Canon', model='Canon EOS 5D', taken=None,
             width=5472, height=3648):
    """A TIFF-based camera RAW: small thumbnail in IFD0, big preview in IFD1."""
    ifd0 = [(0x0100, LONG, 160), (0x0101, LONG, 120), (0x010F, ASCII, make), (0x0110, ASCII, model)]
    if orientation:
        ifd0.append((0x0112, SHORT, orientation))
    ifds = [('ifd0', ifd0)]
    blobs = [('preview', preview)]
    if thumbnail:
        ifd0 += [(0x0103, SHORT, 6), (0x0201, LONG, ('blob', 'thumb')), (0x0202, LONG, ('blob', 'thumb'))]
        blobs.append(('thumb', thumbnail))
    exif_entries = [(0xA002, LONG, width), (0xA003, LONG, height)]
    if taken:
        exif_entries.append((0x9003, ASCII, taken))
    ifd0.append((0x8769, LONG, ('ifd', 'exif')))
    ifds.append(('exif', exif_entries))
    ifds.append(('ifd1', [(0x0103, SHORT, 6), (0x0201, LONG, ('blob', 'preview')), (0x0202, LONG, ('blob', 'preview'))]))
    return tiff_structure(ifds, '<', blobs)


def raf_file(embedded_jpeg):
    header = b'FUJIFILMCCD-RAW 0201FF383501X-T3'.ljust(84, b'\x00')
    offset = 148
    header += struct.pack('>II', offset, len(embedded_jpeg))
    return header.ljust(offset, b'\x00') + embedded_jpeg


# --- PNG, GIF, BMP ------------------------------------------------------------------------

def _png_chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)


def png(width, height, color=(40, 120, 220), animated_frames=0, exif=None):
    raw = b''.join(b'\x00' + bytes(color) * width for _ in range(height))
    chunks = [_png_chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))]
    if animated_frames:
        chunks.append(_png_chunk(b'acTL', struct.pack('>II', animated_frames, 0)))
    if exif:
        chunks.append(_png_chunk(b'eXIf', exif))
    chunks.append(_png_chunk(b'IDAT', zlib.compress(raw)))
    chunks.append(_png_chunk(b'IEND', b''))
    return b'\x89PNG\r\n\x1a\n' + b''.join(chunks)


def _gif_frame(width, height, index):
    """An image descriptor + LZW data painting every pixel with palette `index`.

    The data is "uncompressed" LZW: a Clear code after every two pixels keeps
    the code size at 3 bits, which every decoder accepts.
    """
    bits = []
    clear, end = 4, 5
    pixels = width * height
    written = 0
    while written < pixels:
        bits.append(clear)
        for _ in range(min(2, pixels - written)):
            bits.append(index)
            written += 1
    bits.append(end)
    accumulator = 0
    count = 0
    data = bytearray()
    for code in bits:
        accumulator |= code << count
        count += 3
        while count >= 8:
            data.append(accumulator & 0xFF)
            accumulator >>= 8
            count -= 8
    if count:
        data.append(accumulator & 0xFF)
    blocks = b''.join(bytes([len(data[i:i + 255])]) + bytes(data[i:i + 255]) for i in range(0, len(data), 255))
    control = b'\x21\xf9\x04\x00\x0a\x00\x00\x00'  # 100 ms per frame
    return control + b'\x2c' + struct.pack('<HHHHB', 0, 0, width, height, 0) + b'\x02' + blocks + b'\x00'


def gif(width, height, frames=1):
    palette = bytes([230, 60, 60, 60, 160, 230, 250, 210, 60, 30, 30, 30])
    header = b'GIF89a' + struct.pack('<HHBBB', width, height, 0x81, 0, 0) + palette
    loop = b'\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00' if frames > 1 else b''
    return header + loop + b''.join(_gif_frame(width, height, index % 3) for index in range(frames)) + b'\x3b'


def bmp(width, height, color=(20, 180, 90)):
    row = bytes(color[::-1]) * width
    row += b'\x00' * ((4 - len(row) % 4) % 4)
    pixels = row * height
    header = b'BM' + struct.pack('<IHHI', 54 + len(pixels), 0, 0, 54)
    info = struct.pack('<IiiHHIIiiII', 40, width, height, 1, 24, 0, len(pixels), 2835, 2835, 0, 0)
    return header + info + pixels


def webp_vp8x(width, height, animated=False, exif=None):
    flags = (0x02 if animated else 0) | (0x08 if exif else 0)
    body = b'VP8X' + struct.pack('<I', 10) + bytes([flags, 0, 0, 0]) \
        + (width - 1).to_bytes(3, 'little') + (height - 1).to_bytes(3, 'little')
    if exif:
        body += b'EXIF' + struct.pack('<I', len(exif)) + exif + (b'\x00' if len(exif) & 1 else b'')
    return b'RIFF' + struct.pack('<I', 4 + len(body)) + b'WEBP' + body


def webp_vp8(width, height):
    frame = b'\x00\x00\x00' + b'\x9d\x01\x2a' + struct.pack('<HH', width, height) + b'\x00' * 8
    body = b'VP8 ' + struct.pack('<I', len(frame)) + frame
    return b'RIFF' + struct.pack('<I', 4 + len(body)) + b'WEBP' + body


def webp_vp8l(width, height):
    bits = (width - 1) | ((height - 1) << 14)
    frame = b'\x2f' + struct.pack('<I', bits) + b'\x00' * 8
    body = b'VP8L' + struct.pack('<I', len(frame)) + frame
    return b'RIFF' + struct.pack('<I', 4 + len(body)) + b'WEBP' + body


# --- ISO base media (MP4, MOV, HEIF) -----------------------------------------------------------

def box(kind, payload=b''):
    return struct.pack('>I', 8 + len(payload)) + kind + payload


def full_box(kind, version, flags, payload):
    return box(kind, bytes([version]) + flags.to_bytes(3, 'big') + payload)


_ROTATIONS = {
    0: (0x10000, 0, 0, 0x10000),
    90: (0, 0x10000, -0x10000, 0),
    180: (-0x10000, 0, 0, -0x10000),
    270: (0, -0x10000, 0x10000, 0),
}


def mp4(width=1920, height=1080, duration=12.5, timescale=1000, rotation=0, created=None, codec=b'avc1',
        brand=b'isom', version=0, audio=True, fragmented=False):
    """ftyp + moov + mdat. `created` is a Unix time (stored as seconds since 1904)."""
    mac = (created + 2082844800) if created else 0
    units = int(duration * timescale)
    if version == 1:
        mvhd = full_box(b'mvhd', 1, 0, struct.pack('>QQIQ', mac, mac, timescale, 0 if fragmented else units)
                        + b'\x00' * 80)
    else:
        mvhd = full_box(b'mvhd', 0, 0, struct.pack('>IIII', mac, mac, timescale, 0 if fragmented else units)
                        + b'\x00' * 80)
    a, b, c, d = _ROTATIONS[rotation]
    matrix = struct.pack('>9i', a, b, 0, c, d, 0, 0, 0, 0x40000000)
    tkhd = full_box(b'tkhd', 0, 3, struct.pack('>IIIII', mac, mac, 1, 0, units) + b'\x00' * 8
                    + struct.pack('>hhhh', 0, 0, 0, 0) + matrix + struct.pack('>II', width << 16, height << 16))
    mdhd = full_box(b'mdhd', 0, 0, struct.pack('>IIII', mac, mac, 90000, 0 if fragmented else int(duration * 90000))
                    + b'\x00\x00\x00\x00')
    hdlr = full_box(b'hdlr', 0, 0, b'\x00' * 4 + b'vide' + b'\x00' * 12 + b'VideoHandler\x00')
    entry = box(codec, b'\x00' * 6 + b'\x00\x01' + b'\x00' * 16 + struct.pack('>HH', width, height) + b'\x00' * 50)
    stsd = full_box(b'stsd', 0, 0, struct.pack('>I', 1) + entry)
    trak = box(b'trak', tkhd + box(b'mdia', mdhd + hdlr + box(b'minf', box(b'stbl', stsd))))
    tracks = trak
    if audio:
        audio_tkhd = full_box(b'tkhd', 0, 3, struct.pack('>IIIII', mac, mac, 2, 0, units) + b'\x00' * 8
                              + struct.pack('>hhhh', 0, 0, 0x100, 0) + struct.pack('>9i', 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000)
                              + struct.pack('>II', 0, 0))
        audio_hdlr = full_box(b'hdlr', 0, 0, b'\x00' * 4 + b'soun' + b'\x00' * 12 + b'SoundHandler\x00')
        tracks += box(b'trak', audio_tkhd + box(b'mdia', audio_hdlr))
    extra = b''
    fragments = b''
    if fragmented:
        extra = box(b'mvex', full_box(b'trex', 0, 0, struct.pack('>IIIII', 1, 1, 3000, 0, 0)))
        # Two fragments of 90000-unit samples; the second starts at 5 s and holds 25 samples of 3000 -> ends at 5.833 s.
        for base, count in ((0, 150), (450000, 25)):
            tfhd = full_box(b'tfhd', 0, 0x020000, struct.pack('>I', 1))
            tfdt = full_box(b'tfdt', 1, 0, struct.pack('>Q', base))
            trun = full_box(b'trun', 0, 0x000100, struct.pack('>I', count) + struct.pack('>I', 3000) * count)
            fragments += box(b'moof', full_box(b'mfhd', 0, 0, struct.pack('>I', 1)) + box(b'traf', tfhd + tfdt + trun))
            fragments += box(b'mdat', b'\x00' * 16)
    ftyp = box(b'ftyp', brand + b'\x00\x00\x02\x00' + brand + b'mp41')
    return ftyp + box(b'moov', mvhd + tracks + extra) + fragments + box(b'mdat', b'\x00' * 32)


def heif(width=4032, height=3024, rotation_ccw=0, exif_tiff_bytes=None, brand=b'heic'):
    """A HEIF image: primary item 1 with ispe (+ irot), optional Exif item 2."""
    infe_image = full_box(b'infe', 2, 0, struct.pack('>HH', 1, 0) + b'hvc1' + b'\x00')
    items = [infe_image]
    if exif_tiff_bytes:
        items.append(full_box(b'infe', 2, 0, struct.pack('>HH', 2, 0) + b'Exif' + b'\x00'))
    iinf = full_box(b'iinf', 0, 0, struct.pack('>H', len(items)) + b''.join(items))
    pitm = full_box(b'pitm', 0, 0, struct.pack('>H', 1))
    hdlr = full_box(b'hdlr', 0, 0, b'\x00' * 4 + b'pict' + b'\x00' * 12 + b'\x00')
    properties = [full_box(b'ispe', 0, 0, struct.pack('>II', 512, 512)),          # a tile's size (index 1)
                  full_box(b'ispe', 0, 0, struct.pack('>II', width, height))]     # the image's size (index 2)
    associations = [2]
    if rotation_ccw:
        properties.append(box(b'irot', bytes([rotation_ccw // 90])))
        associations.append(3)
    ipco = box(b'ipco', b''.join(properties))
    ipma = full_box(b'ipma', 0, 0, struct.pack('>I', 1) + struct.pack('>HB', 1, len(associations))
                    + bytes(0x80 | index for index in associations))
    iprp = box(b'iprp', ipco + ipma)
    exif_payload = b''
    if exif_tiff_bytes:
        exif_payload = struct.pack('>I', 6) + b'Exif\x00\x00' + exif_tiff_bytes

    def build(exif_offset):
        entries = [struct.pack('>HHH', 1, 0, 1) + struct.pack('>II', 0, 0)]
        if exif_tiff_bytes:
            entries.append(struct.pack('>HHH', 2, 0, 1) + struct.pack('>II', exif_offset, len(exif_payload)))
        iloc = full_box(b'iloc', 0, 0, bytes([0x44, 0x00]) + struct.pack('>H', len(entries)) + b''.join(entries))
        meta = full_box(b'meta', 0, 0, hdlr + pitm + iinf + iloc + iprp)
        ftyp = box(b'ftyp', brand + b'\x00\x00\x00\x00' + b'mif1' + brand)
        return ftyp + meta

    head = build(0)
    offset = len(head) + 8  # the Exif bytes open the mdat payload
    head = build(offset)
    return head + box(b'mdat', exif_payload + b'\x00' * 16)


# --- Matroska / WebM -----------------------------------------------------------------------------

def _vint_size(size):
    for length in range(1, 9):
        if size < (1 << (7 * length)) - 1:
            return ((1 << (7 * length)) | size).to_bytes(length, 'big')
    raise ValueError(size)


def element(element_id, payload):
    identifier = element_id.to_bytes((element_id.bit_length() + 7) // 8, 'big')
    return identifier + _vint_size(len(payload)) + payload


def _uint(value):
    return value.to_bytes(max(1, (value.bit_length() + 7) // 8), 'big')


def matroska(width=1280, height=720, duration_ms=8000.0, codec='V_VP9', doctype='webm', date_ns=None,
             tracks_after_cluster=False):
    header = element(0x1A45DFA3, element(0x4282, doctype.encode()) + element(0x4287, _uint(4)))
    info_body = element(0x2AD7B1, _uint(1000000)) + element(0x4489, struct.pack('>d', duration_ms))
    if date_ns is not None:
        info_body += element(0x4461, date_ns.to_bytes(8, 'big', signed=True))
    info = element(0x1549A966, info_body)
    video = element(0xE0, element(0xB0, _uint(width)) + element(0xBA, _uint(height)))
    audio_track = element(0xAE, element(0xD7, _uint(2)) + element(0x83, _uint(2)) + element(0x86, b'A_OPUS'))
    video_track = element(0xAE, element(0xD7, _uint(1)) + element(0x83, _uint(1)) + element(0x86, codec.encode()) + video)
    tracks = element(0x1654AE6B, audio_track + video_track)
    cluster = element(0x1F43B675, element(0xE7, _uint(0)) + element(0xA3, b'\x81\x00\x00\x80' + b'\x00' * 32))
    if not tracks_after_cluster:
        segment_body = info + tracks + cluster
        return header + element(0x18538067, segment_body)
    # Info and Tracks after the first Cluster, found through the SeekHead.
    def seek_head(info_position, tracks_position):
        return element(0x114D9B74,
                       element(0x4DBB, element(0x53AB, (0x1549A966).to_bytes(4, 'big')) + element(0x53AC, info_position.to_bytes(4, 'big')))
                       + element(0x4DBB, element(0x53AB, (0x1654AE6B).to_bytes(4, 'big')) + element(0x53AC, tracks_position.to_bytes(4, 'big'))))
    first = seek_head(0, 0)
    info_position = len(first) + len(cluster)
    tracks_position = info_position + len(info)
    segment_body = seek_head(info_position, tracks_position) + cluster + info + tracks
    return header + element(0x18538067, segment_body)


# --- AVI -------------------------------------------------------------------------------------------

def _riff_chunk(fourcc, data):
    return fourcc + struct.pack('<I', len(data)) + data + (b'\x00' if len(data) & 1 else b'')


def _riff_list(kind, data):
    return _riff_chunk(b'LIST', kind + data)


def avi(width=640, height=480, frames=250, fps=25, codec=b'XVID', odml_frames=None):
    avih = struct.pack('<IIIIIIIIII', int(1e6 / fps), 0, 0, 0, frames, 0, 1, 0, width, height) + b'\x00' * 16
    strh = b'vids' + codec + struct.pack('<IHHIIIIIIIi', 0, 0, 0, 0, 1, fps, 0, odml_frames or frames, 0, 0, 0) + b'\x00' * 8
    strf = struct.pack('<IiiHH', 40, width, height, 1, 24) + codec + b'\x00' * 20
    hdrl = _riff_chunk(b'avih', avih) + _riff_list(b'strl', _riff_chunk(b'strh', strh) + _riff_chunk(b'strf', strf))
    if odml_frames:
        hdrl += _riff_list(b'odml', _riff_chunk(b'dmlh', struct.pack('<I', odml_frames) + b'\x00' * 244))
    body = b'AVI ' + _riff_list(b'hdrl', hdrl) + _riff_list(b'movi', b'')
    return b'RIFF' + struct.pack('<I', len(body)) + body


def transport_stream(packets=6, packet_size=188):
    packet = b'\x47' + b'\x1f\xff\x10' + b'\xff' * 184
    if packet_size == 192:
        packet = b'\x00\x00\x00\x00' + packet
    return packet * packets


# --- Real video for the browser ------------------------------------------------------------------------

TINY_WEBM = base64.b64decode(
    'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAMhEU2bdLpNu4tT'
    'q4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEiTbuMU6uEHFO7a1OsggL57AEA'
    'AAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZm'
    'NTguNzYuMTAwV0GNTGF2ZjU4Ljc2LjEwMESJiECXcAAAAAAAFlSua8WuAQAAAAAAADzXgQFzxYjT'
    'YSeZp8hCopyBACK1nIN1bmSGhVZfVlA4g4EBI+ODhA7msoDgAQAAAAAAAAmwgUC6gTCagQISVMNn'
    'QJpzcwEAAAAAAAAnY8CAZ8gBAAAAAAAAGkWjh0VOQ09ERVJEh41MYXZmNTguNzYuMTAwc3MBAAAA'
    'AAAAX2PAi2PFiNNhJ5mnyEKiZ8gBAAAAAAAAIkWjh0VOQ09ERVJEh5VMYXZjNTguMTM0LjEwMCBs'
    'aWJ2cHhnyKJFo4hEVVJBVElPTkSHlDAwOjAwOjAxLjUwMDAwMDAwMAAAH0O2dUEx54EAo+WBAACA'
    'cAUAnQEqQAAwAABHCIWFiIWEiAICAnXVC/gP4A8pUxHgP4A/pnuIAJhTNi5QKSIut9fOiAD+/kXY'
    'XQUK776TizZlm5/4zwyxJQvICcD9E309ZNms/+WsAA732j4AYiaoAKOWgQD6ANEBAAEQEAAYABhY'
    'L/QACIwAAKOWgQH0ANEBAAEQEAAYABhYL/QACIwAAKOWgQLuANEBAAEQEAAYABhYL/QACIwAAKPl'
    'gQPogHAFAJ0BKkAAMAAARwiFhYiFhIgCAgJ11Qv4D+APKVMR4D+AP6Z7iACYUzYuUCkiLrfXzogA'
    '/v5F2F0FCu++k4s2ZZuf+M8MsSULyAnA/RN9PWTZrP/lrAAO99o+AGImqACjloEE4gDRAQABEBAA'
    'GAAYWC/0AAiMAAAcU7tro7uPs4EAt4r3gQHxggHC8IEDu5CzggPot4r3gQHxggHC8IGy'
)


# --- A sample album on disk ---------------------------------------------------------------------------------

def write(path, data, mtime=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as handle:
        handle.write(data)
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def two_tone(width, height, top=(220, 40, 40), bottom=(40, 60, 220)):
    """Top half one colour, bottom half another: shows orientation at a glance."""
    rows = (height + 7) // 8
    return lambda bx, by: top if by < rows // 2 else bottom


def make_album(root):
    """A small album exercising every kind of entry the scanner meets.

    Returns {relative path: expectation} for the media files that must be found.
    """
    thumbnail = jpeg(160, 120, color=(250, 200, 60))
    files = {}

    def add(rel, data, mtime=None):
        write(os.path.join(root, *rel.split('/')), data, mtime)
        files[rel] = data

    add('beach.jpg', jpeg(64, 48, blocks=two_tone(64, 48), exif=exif_segment(
        orientation=6, make='Canon', model='Canon EOS R5', taken='2023:07:14 10:30:00', thumbnail=thumbnail,
        gps=(36.5, -4.9), exposure={'time': (1, 250), 'f': (28, 10), 'iso': 100})), mtime=1700000000)
    add('sunset.png', png(96, 40, color=(250, 120, 30)), mtime=1600000000)
    add('spinner.gif', gif(24, 24, frames=3), mtime=1650000000)
    add('clip.webm', TINY_WEBM, mtime=1690000000)
    add('trips/2022/paris.jpg', jpeg(48, 64, color=(90, 160, 220), exif=exif_segment(
        make='NIKON CORPORATION', model='NIKON D750', taken='2022:05:01 18:00:00')), mtime=1651400000)
    add('trips/2022/louvre.bmp', bmp(40, 30), mtime=1651500000)
    add('trips/2022/raw/IMG_0001.CR2', raw_file(jpeg(120, 80, color=(120, 200, 120)) + b'\x00' * 3000,
                                                 orientation=1, taken='2022:05:02 09:15:00'), mtime=1651500100)
    add('.hidden/secret.jpg', jpeg(16, 16, color=(10, 10, 10)), mtime=1500000000)
    add('videos/movie.mp4', mp4(1920, 1080, duration=12.5, rotation=90, created=1609459200), mtime=1609459300)
    add('videos/phone.mkv', matroska(1280, 720, 8000.0, codec='V_MPEG4/ISO/AVC', doctype='matroska'),
        mtime=1609459400)
    add('videos/old.avi', avi(640, 480, frames=250, fps=25), mtime=1400000000)
    add('videos/stream.ts', transport_stream(), mtime=1400000100)
    # Not media, or not to be followed:
    write(os.path.join(root, 'trips', '2022', 'notes.txt'), b'not media')
    write(os.path.join(root, 'code', 'app.ts'), b'export const answer = 42;\n')
    write(os.path.join(root, 'code', 'types.d.ts'), b'declare const x: number;\n')
    os.makedirs(os.path.join(root, 'trips', 'empty'), exist_ok=True)
    try:
        os.symlink(os.path.join(root, 'beach.jpg'), os.path.join(root, 'link.jpg'))
        os.symlink(os.path.join(root, 'trips'), os.path.join(root, 'trips-link'))
    except (OSError, NotImplementedError):
        pass
    return files
