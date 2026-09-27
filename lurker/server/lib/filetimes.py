"""File creation ("birth") time, where the operating system records one.

`os.stat` exposes it as `st_birthtime` on macOS, the BSDs and Windows with
Python 3.12+. Older Windows Pythons put the creation time in `st_ctime`. Linux
records it on ext4, btrfs, xfs and others, but Python 3.10 does not expose it,
so the `statx` system call is made through ctypes (part of the standard
library). On Linux `st_ctime` is the inode *change* time, and it is never
passed off as a creation date.
"""
import ctypes
import os
import sys

_AT_FDCWD = -100
_AT_SYMLINK_NOFOLLOW = 0x100
_STATX_BTIME = 0x800
_STATX_SIZE = 256            # struct statx is 256 bytes on every architecture
_BTIME_OFFSET = 80           # stx_btime: { __s64 tv_sec; __u32 tv_nsec; __s32 pad; }
_MASK_OFFSET = 0

_statx = None
if sys.platform.startswith('linux'):
    try:
        _libc = ctypes.CDLL(None, use_errno=True)
        _statx = _libc.statx
        _statx.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p)
        _statx.restype = ctypes.c_int
    except (OSError, AttributeError):  # glibc older than 2.28, or no libc at all
        _statx = None


def birth_time(path, stat_result=None):
    """Creation time in seconds since the epoch, or None when it is unknown."""
    if stat_result is not None:
        value = getattr(stat_result, 'st_birthtime', None)
        if value:
            return float(value)
        if os.name == 'nt':
            return float(stat_result.st_ctime)
    if _statx is None:
        return None
    buffer = ctypes.create_string_buffer(_STATX_SIZE)
    try:
        encoded = os.fsencode(path)
    except (TypeError, ValueError):
        return None
    if _statx(_AT_FDCWD, encoded, _AT_SYMLINK_NOFOLLOW, _STATX_BTIME, buffer) != 0:
        return None
    mask = int.from_bytes(buffer.raw[_MASK_OFFSET:_MASK_OFFSET + 4], sys.byteorder)
    if not mask & _STATX_BTIME:
        return None
    seconds = int.from_bytes(buffer.raw[_BTIME_OFFSET:_BTIME_OFFSET + 8], sys.byteorder, signed=True)
    nanos = int.from_bytes(buffer.raw[_BTIME_OFFSET + 8:_BTIME_OFFSET + 12], sys.byteorder)
    if seconds <= 0:
        return None
    return seconds + nanos / 1e9
