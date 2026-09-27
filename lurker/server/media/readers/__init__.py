"""Header readers, one per container family.

A reader is `read(source, detail=False) -> dict` and raises
binary.Malformed when the bytes are not its format. Keys it may return:

    width, height   stored pixel size (before orientation or rotation)
    orientation     EXIF orientation 1-8 (images)
    rotation        clockwise degrees a player applies (videos, HEIF)
    duration        seconds
    taken           when the photo/video was made, as Unix seconds;
    takenUtc        ...True when that is a real instant, absent when it is
                    a camera wall-clock time with no time zone (EXIF)
    camera, codec   short strings
    animated        True for animated GIF / APNG / WebP
    preview         (offset, length) of an embedded JPEG
    details         extra EXIF fields, only when detail=True

To support a new container: add a module here and one line to READERS, then
point a Format at it in `media/formats.py`.
"""
from . import ebml, gif, isobmff, jpeg, png, riff, simple, tiff, webp

READERS = {
    'jpeg': jpeg.read,
    'png': png.read,
    'gif': gif.read,
    'webp': webp.read,
    'bmp': simple.read_bmp,
    'ico': simple.read_ico,
    'psd': simple.read_psd,
    'svg': simple.read_svg,
    'tiff': tiff.read,
    'raf': tiff.read_raf,
    'isobmff': isobmff.read,
    'ebml': ebml.read,
    'riff': riff.read_avi,
    'mpegts': riff.read_ts,
}
