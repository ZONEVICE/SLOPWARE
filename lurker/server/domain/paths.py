"""Checking the directory a user asks for, and helping them type it.

A path is accepted when it is absolute, exists, is a directory, and its
listing can actually be read (os.access alone lies on some network mounts,
so the check opens it). `~` is expanded: it names one directory on the
server just as unambiguously as an absolute path does.
"""
import os
import stat
from dataclasses import asdict, dataclass
from typing import Optional


@dataclass
class PathCheck:
    ok: bool
    path: str
    code: Optional[str] = None
    message: Optional[str] = None
    name: Optional[str] = None
    real: Optional[str] = None

    def as_dict(self):
        return {key: value for key, value in asdict(self).items() if key != 'real'}


def check_directory(raw):
    text = (raw or '').strip()
    if not text:
        return PathCheck(False, '', 'empty', 'Type the absolute path of a directory.')
    if '\x00' in text:
        return PathCheck(False, text, 'invalid', 'That path contains a NUL character.')
    expanded = os.path.expanduser(text)
    if not os.path.isabs(expanded):
        return PathCheck(False, text, 'not_absolute',
                         'Use an absolute path, such as %s.' % _example())
    path = os.path.normpath(expanded)
    if path.startswith('//') and os.name != 'nt':
        path = '/' + path.lstrip('/')  # POSIX keeps a leading "//"; it means nothing here
    try:
        info = os.stat(path)
    except FileNotFoundError:
        return PathCheck(False, path, 'not_found', 'Nothing exists at that path.')
    except PermissionError:
        return PathCheck(False, path, 'not_readable', 'Lurker is not allowed to look inside that path.')
    except (OSError, ValueError) as error:
        return PathCheck(False, path, 'not_found', 'That path cannot be used: %s.' % _reason(error))
    if not stat.S_ISDIR(info.st_mode):
        return PathCheck(False, path, 'not_directory', 'That is a file, not a directory.')
    try:
        with os.scandir(path) as listing:
            next(listing, None)
    except PermissionError:
        return PathCheck(False, path, 'not_readable', 'Lurker is not allowed to read that directory.')
    except OSError as error:
        return PathCheck(False, path, 'not_readable', 'That directory cannot be read: %s.' % _reason(error))
    real = os.path.realpath(path)
    name = os.path.basename(path.rstrip(os.sep)) or path
    return PathCheck(True, path, name=name, real=real)


def suggest(raw, limit=12):
    """Directories that complete what has been typed so far (case-insensitive)."""
    text = os.path.expanduser((raw or '').strip())
    if not text or not os.path.isabs(text):
        return []
    if text.endswith(os.sep) or (os.altsep and text.endswith(os.altsep)):
        parent, prefix = text, ''
    else:
        parent, prefix = os.path.split(text)
    lowered = prefix.lower()
    found = []
    try:
        with os.scandir(parent or os.sep) as listing:
            for entry in listing:
                name = entry.name
                if not name.lower().startswith(lowered):
                    continue
                if name.startswith('.') and not prefix.startswith('.'):
                    continue  # hidden directories only when the user types the dot
                try:
                    if entry.is_dir():
                        found.append(os.path.join(parent, name))
                except OSError:
                    continue
    except (OSError, ValueError):
        return []
    found.sort(key=lambda path: (os.path.basename(path).lower(), path))
    return found[:limit]


def shortcuts():
    """Places worth offering on the start screen: home, pictures, videos, drives."""
    home = os.path.expanduser('~')
    candidates = [('Home', home)]
    xdg = _xdg_user_dirs(home)
    candidates += [
        ('Pictures', xdg.get('XDG_PICTURES_DIR') or os.path.join(home, 'Pictures')),
        ('Videos', xdg.get('XDG_VIDEOS_DIR') or os.path.join(home, 'Videos')),
        ('Downloads', xdg.get('XDG_DOWNLOAD_DIR') or os.path.join(home, 'Downloads')),
        ('Desktop', xdg.get('XDG_DESKTOP_DIR') or os.path.join(home, 'Desktop')),
    ]
    user = os.path.basename(home)
    for mounts in ('/media/' + user, '/run/media/' + user, '/Volumes'):
        try:
            with os.scandir(mounts) as listing:
                for entry in sorted(listing, key=lambda e: e.name.lower()):
                    if entry.is_dir() and not entry.name.startswith('.'):
                        candidates.append((entry.name, entry.path))
        except OSError:
            continue
    seen = set()
    result = []
    for label, path in candidates:
        if path in seen or not os.path.isdir(path) or (label != 'Home' and path == home):
            continue
        seen.add(path)
        result.append({'label': label, 'path': path})
    return result


def _xdg_user_dirs(home):
    values = {}
    config = os.environ.get('XDG_CONFIG_HOME') or os.path.join(home, '.config')
    try:
        with open(os.path.join(config, 'user-dirs.dirs'), encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                value = value.strip().strip('"').replace('$HOME', home)
                if os.path.isabs(value) and value.rstrip('/') != home:
                    values[key.strip()] = value
    except (OSError, UnicodeDecodeError):
        pass
    return values


def _example():
    return 'C:\\Users\\you\\Pictures' if os.name == 'nt' else os.path.join(os.path.expanduser('~'), 'Pictures')


def _reason(error):
    return (getattr(error, 'strerror', None) or str(error) or 'unknown error').rstrip('.').lower()
