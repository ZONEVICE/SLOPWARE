"""Every file type Lurker registers, keyed by extension.

`browser` says whether a browser can show the file as it is:

    yes    every current browser (Chrome, Firefox, Safari, Edge)
    maybe  some browsers or some codecs (HEIC in Safari, H.264 in a .mov...);
           the client tries once per format and remembers the answer
    no     no browser; the tile shows a placeholder and offers a download

`reader` names the header reader in `media/readers/` (None: no metadata).
To register a new type, add one Format below; to read its headers, add a
reader module and one line in `media/readers/__init__.py`.
"""
from dataclasses import dataclass
from typing import Optional, Tuple

IMAGE = 'image'
VIDEO = 'video'


@dataclass(frozen=True)
class Format:
    key: str
    label: str
    kind: str
    mime: str
    browser: str
    reader: Optional[str]
    extensions: Tuple[str, ...]


FORMATS = (
    # Images
    Format('jpeg', 'JPEG', IMAGE, 'image/jpeg', 'yes', 'jpeg', ('jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp')),
    Format('png', 'PNG', IMAGE, 'image/png', 'yes', 'png', ('png', 'apng')),
    Format('gif', 'GIF', IMAGE, 'image/gif', 'yes', 'gif', ('gif',)),
    Format('webp', 'WebP', IMAGE, 'image/webp', 'yes', 'webp', ('webp',)),
    Format('avif', 'AVIF', IMAGE, 'image/avif', 'yes', 'isobmff', ('avif',)),
    Format('heic', 'HEIC', IMAGE, 'image/heic', 'maybe', 'isobmff', ('heic', 'heif', 'hif')),
    Format('jxl', 'JPEG XL', IMAGE, 'image/jxl', 'maybe', None, ('jxl',)),
    Format('bmp', 'BMP', IMAGE, 'image/bmp', 'yes', 'bmp', ('bmp', 'dib')),
    Format('ico', 'Icon', IMAGE, 'image/x-icon', 'yes', 'ico', ('ico',)),
    Format('svg', 'SVG', IMAGE, 'image/svg+xml', 'yes', 'svg', ('svg',)),
    Format('tiff', 'TIFF', IMAGE, 'image/tiff', 'maybe', 'tiff', ('tif', 'tiff')),
    Format('psd', 'Photoshop', IMAGE, 'image/vnd.adobe.photoshop', 'no', 'psd', ('psd', 'psb')),
    Format('raw', 'Camera RAW', IMAGE, 'application/octet-stream', 'no', 'tiff',
           ('dng', 'cr2', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'orf', 'rw2', 'pef', 'srw', '3fr', 'erf',
            'kdc', 'mef', 'mos', 'iiq', 'rwl')),
    Format('raf', 'Fujifilm RAW', IMAGE, 'application/octet-stream', 'no', 'raf', ('raf',)),
    Format('cr3', 'Canon CR3', IMAGE, 'application/octet-stream', 'no', 'isobmff', ('cr3',)),
    # Videos
    Format('mp4', 'MP4', VIDEO, 'video/mp4', 'yes', 'isobmff', ('mp4', 'm4v')),
    Format('mov', 'QuickTime', VIDEO, 'video/quicktime', 'maybe', 'isobmff', ('mov', 'qt')),
    Format('webm', 'WebM', VIDEO, 'video/webm', 'yes', 'ebml', ('webm',)),
    Format('mkv', 'Matroska', VIDEO, 'video/x-matroska', 'maybe', 'ebml', ('mkv',)),
    Format('ogv', 'Ogg video', VIDEO, 'video/ogg', 'maybe', None, ('ogv',)),
    Format('3gp', '3GP', VIDEO, 'video/3gpp', 'maybe', 'isobmff', ('3gp', '3g2')),
    Format('avi', 'AVI', VIDEO, 'video/x-msvideo', 'no', 'riff', ('avi', 'divx')),
    Format('wmv', 'Windows Media', VIDEO, 'video/x-ms-wmv', 'no', None, ('wmv', 'asf')),
    Format('flv', 'Flash video', VIDEO, 'video/x-flv', 'no', None, ('flv', 'f4v')),
    Format('mpeg', 'MPEG', VIDEO, 'video/mpeg', 'no', None, ('mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'vob')),
    Format('mpegts', 'MPEG-TS', VIDEO, 'video/mp2t', 'no', 'mpegts', ('ts', 'mts', 'm2ts')),
    Format('rm', 'RealMedia', VIDEO, 'application/vnd.rn-realmedia', 'no', None, ('rm', 'rmvb')),
)

BY_KEY = {fmt.key: fmt for fmt in FORMATS}
BY_EXTENSION = {extension: fmt for fmt in FORMATS for extension in fmt.extensions}

# ".ts" and ".mts" are also TypeScript sources. Files with these extensions
# only count as video when their content really is an MPEG transport stream.
CONTENT_CHECKED = frozenset({'ts', 'mts'})


def extension_of(name):
    dot = name.rfind('.')
    if dot < 0 or dot == len(name) - 1:
        return ''
    return name[dot + 1:].lower()


def lookup(name):
    """The Format for a file name, or None when Lurker ignores it."""
    return BY_EXTENSION.get(extension_of(name))


def public_table():
    """The format list as the client receives it."""
    return [
        {'key': fmt.key, 'label': fmt.label, 'kind': fmt.kind, 'mime': fmt.mime,
         'browser': fmt.browser, 'extensions': list(fmt.extensions)}
        for fmt in FORMATS
    ]
