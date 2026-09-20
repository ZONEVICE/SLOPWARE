"""Keep Python-version and operating-system differences in one small module."""
from __future__ import absolute_import, unicode_literals

import errno
import os
import sys

try:
    text_type = unicode
    binary_type = str
    string_types = (basestring,)
except NameError:
    text_type = str
    binary_type = bytes
    string_types = (str, bytes)


def fs_text(value):
    """Return filesystem text without changing already-decoded Unicode paths."""
    if isinstance(value, text_type):
        return value
    if isinstance(value, binary_type):
        encoding = sys.getfilesystemencoding() or "utf-8"
        if sys.version_info[0] >= 3:
            return value.decode(encoding, "surrogateescape")
        return value.decode(encoding)
    return text_type(value)


def ensure_directory(path):
    """Create a directory tree while tolerating another thread creating it."""
    try:
        os.makedirs(path)
    except OSError as exc:
        if exc.errno != errno.EEXIST or not os.path.isdir(path):
            raise


def atomic_replace(source, destination):
    """Replace a file atomically, including on Windows with Python 2.7."""
    if hasattr(os, "replace"):
        os.replace(source, destination)
    elif os.name != "nt":
        os.rename(source, destination)
    else:
        # os.rename cannot replace an existing Windows file on Python 2.7.
        # MoveFileExW also preserves non-ASCII names without a third-party module.
        import ctypes
        from ctypes import wintypes
        move_file = ctypes.windll.kernel32.MoveFileExW
        move_file.argtypes = (wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD)
        move_file.restype = wintypes.BOOL
        if not move_file(fs_text(source), fs_text(destination), 0x1 | 0x8):
            raise ctypes.WinError()


def _windows_attributes(path):
    """Read link metadata itself, including junctions on old Python versions."""
    import ctypes
    from ctypes import wintypes
    get_attributes = ctypes.windll.kernel32.GetFileAttributesW
    get_attributes.argtypes = (wintypes.LPCWSTR,)
    get_attributes.restype = wintypes.DWORD
    attributes = get_attributes(fs_text(path))
    if attributes == 0xffffffff:
        code = ctypes.windll.kernel32.GetLastError()
        if code in (2, 3):  # A missing final component or parent is not a link.
            return None
        raise ctypes.WinError(code)
    return attributes


def is_linklike(path):
    """Recognize POSIX symlinks and Windows directory/file reparse points.

    Python 2's Windows islink() always returns False, so using it to decide
    whether recursive removal is safe would accidentally follow junctions.
    """
    if os.name == "nt":
        attributes = _windows_attributes(path)
        return attributes is not None and bool(attributes & 0x400)
    return os.path.islink(path)


def assert_resolvable(path):
    """Reject reparse traversal where Windows realpath cannot resolve it.

    Before Python 3.8, Windows realpath is not sufficient to enforce a selected
    workspace boundary. Inspect every ancestor, including ancestors above the
    selected root, instead of trusting a lexical prefix in those runtimes.
    """
    if os.name != "nt" or sys.version_info >= (3, 8):
        return
    current = os.path.abspath(fs_text(path))
    while True:
        if is_linklike(current):
            raise OSError(errno.EACCES, "This Python version cannot safely resolve Windows reparse points.", current)
        parent = os.path.dirname(current)
        if parent == current:
            return
        current = parent


def safe_remove_tree(path):
    """Remove a file or directory tree without descending into linklike entries.

    Directory junctions must be removed with rmdir on Windows. Broken directory
    links may report isdir=False, so use the directory attribute of the link
    itself rather than querying whether its target currently exists.
    """
    if is_linklike(path):
        if os.name == "nt" and (_windows_attributes(path) or 0) & 0x10:
            os.rmdir(path)
        else:
            os.unlink(path)
    elif os.path.isdir(path):
        for name in os.listdir(path):
            safe_remove_tree(os.path.join(path, name))
        os.rmdir(path)
    else:
        os.unlink(path)
