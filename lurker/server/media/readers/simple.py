"""Formats whose size sits at a fixed place in the header: BMP, ICO, PSD, SVG."""
import re

from ..binary import Malformed, s32le, u16le, u32be, u32le


def read_bmp(source, detail=False):
    header = source.read(0, 26)
    if len(header) < 26 or header[:2] != b'BM':
        raise Malformed('not a BMP')
    if u32le(header, 14) == 12:  # OS/2 BITMAPCOREHEADER
        width, height = u16le(header, 18), u16le(header, 20)
    else:
        width, height = s32le(header, 18), abs(s32le(header, 22))  # negative height: top-down rows
    if width <= 0 or height <= 0:
        raise Malformed('BMP without a size')
    return {'width': width, 'height': height}


def read_ico(source, detail=False):
    header = source.read(0, 6)
    if len(header) < 6 or header[:2] != b'\x00\x00' or u16le(header, 2) not in (1, 2):
        raise Malformed('not an icon')
    count = min(u16le(header, 4), 64)
    entries = source.read(6, count * 16)
    best = None
    for index in range(len(entries) // 16):
        width = entries[index * 16] or 256
        height = entries[index * 16 + 1] or 256
        if best is None or width * height > best[0] * best[1]:
            best = (width, height)
    if best is None:
        raise Malformed('icon without images')
    return {'width': best[0], 'height': best[1]}


def read_psd(source, detail=False):
    header = source.read(0, 26)
    if len(header) < 26 or header[:4] != b'8BPS':
        raise Malformed('not a PSD')
    return {'width': u32be(header, 18), 'height': u32be(header, 14)}


_SVG_TAG = re.compile(rb'<svg\b([^>]*)>', re.IGNORECASE | re.DOTALL)
_ATTRIBUTE = re.compile(rb'([\w:-]+)\s*=\s*(["\'])(.*?)\2', re.DOTALL)
_LENGTH = re.compile(r'^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$')


def read_svg(source, detail=False):
    """Only the aspect ratio matters for layout: width/height, else the viewBox."""
    match = _SVG_TAG.search(source.read(0, 16 * 1024))
    if not match:
        raise Malformed('no <svg> element')
    attributes = {name.decode('ascii', 'replace').lower(): value.decode('utf-8', 'replace')
                  for name, _, value in _ATTRIBUTE.findall(match.group(1))}
    width = _length(attributes.get('width'))
    height = _length(attributes.get('height'))
    if not (width and height):
        box = attributes.get('viewbox', '').replace(',', ' ').split()
        try:
            width, height = float(box[2]), float(box[3])
        except (IndexError, ValueError):
            raise Malformed('SVG without a size') from None
    if width <= 0 or height <= 0:
        raise Malformed('SVG without a size')
    return {'width': max(1, round(width)), 'height': max(1, round(height))}


def _length(value):
    if not value:
        return None
    match = _LENGTH.match(value)
    return float(match.group(1)) if match else None
