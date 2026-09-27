"""Walking the album's directory tree.

The walk is iterative (no recursion limit), visits directories in name order
so IDs are stable between runs, and never follows symbolic links: a link can
point outside the album or back into it, and serving either would be wrong.
Unreadable directories are counted and reported, not fatal.

The same walk serves the first scan and every rescan: `Catalog.sync_folder`
adds what is new, updates what changed and removes what disappeared.
"""
import os
import stat
import time

from ..media import formats
from ..media.probe import content_matches

# Pseudo-filesystems that only matter when someone opens "/" itself.
_SYSTEM_DIRECTORIES = frozenset({'/proc', '/sys', '/dev', '/run'})
_MAX_ERRORS = 20


class ScanStats:
    def __init__(self, rescan=False):
        self.rescan = rescan
        self.directories = 0
        self.files = 0
        self.skipped = 0
        self.errors = []
        self.current = ''
        self.started = time.time()
        self.finished = None

    def as_dict(self):
        end = self.finished or time.time()
        return {
            'rescan': self.rescan, 'directories': self.directories, 'files': self.files,
            'skipped': self.skipped, 'errors': list(self.errors), 'current': self.current,
            'startedAt': self.started, 'finishedAt': self.finished, 'seconds': round(end - self.started, 2),
        }

    def error(self, rel, error):
        self.skipped += 1
        if len(self.errors) < _MAX_ERRORS:
            reason = getattr(error, 'strerror', None) or str(error)
            self.errors.append({'path': rel or '.', 'message': reason})


def is_hidden(name, info=None):
    if name.startswith('.'):
        return True
    attributes = getattr(info, 'st_file_attributes', 0) if info is not None else 0
    return bool(attributes & getattr(stat, 'FILE_ATTRIBUTE_HIDDEN', 0))


def _maybe_transport_stream(entry, name):
    """Cheap rejections first: most .ts files on a developer's disk are TypeScript."""
    if name.endswith(('.d.ts', '.d.mts')):
        return False
    try:
        if entry.stat(follow_symlinks=False).st_size < 1024:
            return False
    except OSError:
        return False
    return content_matches(entry.path, formats.BY_KEY['mpegts'])


def walk(catalog, stats, cancelled, on_new_items):
    """Scan the whole tree into `catalog`. Returns False when cancelled.

    `on_new_items(items)` receives each batch of new or changed items (to be
    probed); `cancelled()` is polled between directories.

    This loop runs once per file on disk (a home directory has millions), so
    it avoids per-entry work: DirEntry's type checks need no system call, the
    extension lookup is inlined, and only media files and subdirectories are
    sorted, never the whole listing.
    """
    root = catalog.real_root
    by_extension = formats.BY_EXTENSION
    checked = formats.CONTENT_CHECKED
    stat_directories = os.name == 'nt'  # only Windows has a "hidden" attribute to read
    seen = set()
    # Stack of (absolute path, relative parts, hidden flag per part).
    stack = [(root, (), ())]
    while stack:
        if cancelled():
            return False
        path, parts, hidden_parts = stack.pop()
        rel = '/'.join(parts)
        stats.current = rel
        media = []
        subdirectories = []
        try:
            with os.scandir(path) as listing:
                for entry in listing:
                    name = entry.name
                    try:
                        if entry.is_dir(follow_symlinks=False):  # False for a symlink to a directory
                            subdirectories.append(entry)
                            continue
                        dot = name.rfind('.')
                        if dot < 0:
                            continue
                        extension = name[dot + 1:].lower()
                        fmt = by_extension.get(extension)
                        if fmt is None or not entry.is_file(follow_symlinks=False):  # False for symlinks
                            continue
                        if extension in checked and not _maybe_transport_stream(entry, name):
                            continue
                        media.append((entry, fmt))
                    except OSError:
                        continue
        except OSError as error:
            stats.error(rel, error)
            continue
        stats.directories += 1
        seen.add(parts)
        files = []
        for entry, fmt in media:
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError:
                continue  # vanished between the listing and now
            files.append((entry.name, fmt, info.st_size, info.st_mtime_ns, is_hidden(entry.name, info)))
        files.sort(key=lambda file: file[0])
        stats.files += len(files)

        folder = catalog.find_folder(parts)
        if files and folder is None:
            folder = catalog.ensure_folder(list(parts), list(hidden_parts))
        if folder is not None:
            changed = catalog.sync_folder(folder, files)
            if changed:
                on_new_items(changed)

        subdirectories.sort(key=lambda entry: entry.name, reverse=True)  # the stack pops them in name order
        for entry in subdirectories:
            child = entry.path
            if root == '/' and child in _SYSTEM_DIRECTORIES:
                continue
            hidden = entry.name.startswith('.')
            if stat_directories and not hidden:
                try:
                    hidden = is_hidden(entry.name, entry.stat(follow_symlinks=False))
                except OSError:
                    pass
            stack.append((child, parts + (entry.name,), hidden_parts + (hidden,)))

    # A rescan: whatever the walk did not reach is gone.
    for folder in [f for f in catalog.folders if f.alive and f is not catalog.root]:
        if tuple(folder.rel.split('/')) not in seen and folder.alive:
            catalog.remove_folder_tree(folder)
    if () not in seen:
        catalog.sync_folder(catalog.root, [])
    catalog.prune_empty()
    return True
