"""TIFF images and TIFF-based camera RAWs (DNG, CR2, NEF, ARW, ORF, RW2...).

Browsers cannot show RAW data, but nearly every RAW carries a JPEG rendering
of the photo for the camera's own screen. The largest one found becomes the
item's preview, so RAW files get a real picture in the grid and the viewer.
Fujifilm's RAF is not TIFF-based; its preview sits at a fixed header offset.
"""
from .. import exif
from ..binary import Malformed, u32be
from . import jpeg

_MIN_PREVIEW = 2048  # smaller "JPEGs" are usually strips of something else


def read(source, detail=False):
    info = exif.parse(source, detail=detail, collect_jpegs=True)
    result = {key: info[key] for key in ('orientation', 'camera', 'taken', 'details') if key in info}
    if info.get('exifWidth') and info.get('exifHeight'):
        result['width'], result['height'] = info['exifWidth'], info['exifHeight']
    elif info.get('largestWidth'):
        result['width'], result['height'] = info['largestWidth'], info['largestHeight']

    best = None
    for start, length in info.get('jpegs', []):
        if length < _MIN_PREVIEW or start + length > source.size:
            continue
        if source.read(start, 2) != b'\xff\xd8':
            continue
        if best is None or length > best[1]:
            best = (start, length)
    if best:
        result['preview'] = best
        if 'width' not in result:
            try:
                inner = jpeg.read(source.window(best[0], best[1]))
                if inner.get('width'):
                    result['width'], result['height'] = inner['width'], inner['height']
            except Malformed:
                pass
    return result


def read_raf(source, detail=False):
    header = source.read(0, 92)
    if len(header) < 92 or not header.startswith(b'FUJIFILMCCD-RAW'):
        raise Malformed('not a RAF')
    start, length = u32be(header, 84), u32be(header, 88)
    if not length or start + length > source.size:
        raise Malformed('RAF without a preview')
    embedded = source.window(start, length)
    result = jpeg.read(embedded, detail=detail)
    # The embedded JPEG's own thumbnail is useless here: the whole JPEG is the preview.
    result['preview'] = (start, length)
    return result
