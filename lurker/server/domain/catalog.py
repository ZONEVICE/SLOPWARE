"""The album's in-memory index: folders and media items, with revisions.

Every change stamps the touched folder or item with the next revision, and
`commit()` publishes that revision. A client that last saw revision N asks
for `delta(N)` and receives exactly what changed since, including removals.
Revision 0 means "everything". IDs are never reused within an album, so a
stale ID can only miss, never point at a different file.

Folders are registered lazily: a directory appears only once it, or
something below it, holds media. Scanning a home directory full of source
trees therefore does not flood the client with thousands of empty folders.

All methods take the catalog's lock; callers never touch the lists directly.
"""
import os
import threading
import zlib

from ..media import formats


def display_name(name):
    """A file name as text: bytes that are not UTF-8 (surrogate escapes) become U+FFFD."""
    try:
        name.encode('utf-8')
        return name
    except UnicodeEncodeError:
        return name.encode('utf-8', 'surrogateescape').decode('utf-8', 'replace')


class Folder:
    __slots__ = ('id', 'parent', 'name', 'rel', 'hidden', 'rev', 'alive', 'items', 'children')

    def __init__(self, folder_id, parent, name, rel, hidden):
        self.id = folder_id
        self.parent = parent            # Folder, or None for the root
        self.name = name
        self.rel = rel                  # '' for the root, else 'a/b/c' with forward slashes
        self.hidden = hidden            # this folder or an ancestor starts with a dot
        self.rev = 0
        self.alive = True
        self.items = {}                 # file name -> Item
        self.children = {}              # directory name -> Folder

    def wire(self):
        data = {'i': self.id, 'p': self.parent.id if self.parent else None, 'n': display_name(self.name)}
        if self.hidden:
            data['x'] = 1
        return data


class Item:
    __slots__ = ('id', 'folder', 'name', 'fmt', 'size', 'mtime_ns', 'hidden', 'rev', 'alive', 'version',
                 'probed', 'width', 'height', 'duration', 'taken', 'taken_utc', 'birth', 'orientation',
                 'camera', 'codec', 'animated', 'preview', 'preview_large')

    def __init__(self, item_id, folder, name, fmt, size, mtime_ns, hidden):
        self.id = item_id
        self.folder = folder
        self.name = name
        self.fmt = fmt
        self.hidden = hidden
        self.rev = 0
        self.alive = True
        self.set_file(size, mtime_ns)

    def set_file(self, size, mtime_ns):
        self.size = size
        self.mtime_ns = mtime_ns
        # Part of every media URL, so a changed file never comes from a stale browser cache.
        self.version = '%x' % (zlib.crc32(('%d:%d' % (size, mtime_ns)).encode()) & 0xFFFFFFFF)
        self.clear_meta()

    def clear_meta(self):
        self.probed = False
        self.width = self.height = self.duration = None
        self.taken = self.birth = self.orientation = None
        self.taken_utc = False
        self.camera = self.codec = None
        self.animated = False
        self.preview = None
        self.preview_large = False

    @property
    def kind(self):
        return self.fmt.kind

    def apply_meta(self, meta, birth):
        self.probed = True
        self.width = meta.get('displayWidth')
        self.height = meta.get('displayHeight')
        duration = meta.get('duration')
        self.duration = round(duration, 3) if duration else None
        self.taken = int(meta['taken']) if meta.get('taken') else None
        self.taken_utc = bool(meta.get('takenUtc'))
        self.birth = int(birth) if birth else None
        orientation = meta.get('orientation')
        self.orientation = orientation if orientation and orientation != 1 else None
        self.camera = meta.get('camera')
        self.codec = meta.get('codec')
        self.animated = bool(meta.get('animated'))
        self.preview = meta.get('preview')
        # A large embedded JPEG (camera RAW) is good enough for the viewer, not just a tile.
        self.preview_large = bool(self.preview and self.preview[1] >= 100 * 1024)

    def wire(self):
        data = {'i': self.id, 'd': self.folder.id, 'n': display_name(self.name), 'f': self.fmt.key,
                's': self.size, 'm': self.mtime_ns // 1000000000, 'v': self.version}
        if self.hidden:
            data['x'] = 1
        if self.probed:
            data['p'] = 1
            for key, value in (('w', self.width), ('h', self.height), ('u', self.duration), ('t', self.taken),
                               ('b', self.birth), ('o', self.orientation), ('c', self.camera), ('k', self.codec)):
                if value is not None:
                    data[key] = value
            if self.taken is not None and self.taken_utc:
                data['z'] = 1
            if self.animated:
                data['a'] = 1
            if self.preview:
                data['r'] = 2 if self.preview_large else 1
        return data


class Catalog:
    def __init__(self, album_id, real_root):
        self.album_id = album_id
        self.real_root = real_root
        self.lock = threading.RLock()
        self.rev = 0
        self.dirty = False
        self.folders = []
        self.items = []
        self.removed_items = []      # (rev, id)
        self.removed_folders = []    # (rev, id)
        self.root = self._new_folder(None, '', '', False)
        self.counts = {'images': 0, 'videos': 0, 'bytes': 0, 'probed': 0}

    # --- writing -------------------------------------------------------------

    def _stamp(self, entry):
        entry.rev = self.rev + 1
        self.dirty = True

    def _new_folder(self, parent, name, rel, hidden):
        folder = Folder(len(self.folders), parent, name, rel, hidden)
        self.folders.append(folder)
        if parent is not None:
            parent.children[name] = folder
        self._stamp(folder)
        return folder

    def ensure_folder(self, rel_parts, hidden_parts):
        """The Folder for a relative path, creating it and its ancestors as needed."""
        with self.lock:
            folder = self.root
            for index, name in enumerate(rel_parts):
                child = folder.children.get(name)
                if child is None or not child.alive:
                    rel = '/'.join(rel_parts[:index + 1])
                    child = self._new_folder(folder, name, rel, folder.hidden or hidden_parts[index])
                folder = child
            return folder

    def find_folder(self, rel_parts):
        with self.lock:
            folder = self.root
            for name in rel_parts:
                folder = folder.children.get(name)
                if folder is None or not folder.alive:
                    return None
            return folder

    def sync_folder(self, folder, files):
        """Make `folder` hold exactly `files`: [(name, fmt, size, mtime_ns, hidden)].

        Returns the items that are new or whose file changed: they need probing.
        """
        changed = []
        with self.lock:
            present = set()
            for name, fmt, size, mtime_ns, hidden in files:
                present.add(name)
                item = folder.items.get(name)
                if item is not None and item.alive:
                    if item.size == size and item.mtime_ns == mtime_ns and item.fmt is fmt:
                        continue
                    self._count(item, -1)
                    item.fmt = fmt
                    item.set_file(size, mtime_ns)
                    item.hidden = hidden or folder.hidden
                    self._count(item, +1)
                else:
                    item = Item(len(self.items), folder, name, fmt, size, mtime_ns, hidden or folder.hidden)
                    self.items.append(item)
                    folder.items[name] = item
                    self._count(item, +1)
                self._stamp(item)
                changed.append(item)
            for name in [name for name in folder.items if name not in present]:
                self._remove_item(folder.items.pop(name))
        return changed

    def remove_folder_tree(self, folder):
        with self.lock:
            for child in list(folder.children.values()):
                self.remove_folder_tree(child)
            for item in list(folder.items.values()):
                self._remove_item(item)
            folder.items.clear()
            if folder is not self.root:
                folder.alive = False
                if folder.parent is not None:
                    folder.parent.children.pop(folder.name, None)
                self.removed_folders.append((self.rev + 1, folder.id))
                self.dirty = True

    def prune_empty(self):
        """Drop folders that no longer hold media anywhere below them."""
        with self.lock:
            def walk(folder):
                has_media = bool(folder.items)
                for child in list(folder.children.values()):
                    has_media = walk(child) or has_media
                if not has_media and folder is not self.root:
                    self.remove_folder_tree(folder)
                return has_media
            walk(self.root)

    def _remove_item(self, item):
        if not item.alive:
            return
        item.alive = False
        self._count(item, -1)
        self.removed_items.append((self.rev + 1, item.id))
        self.dirty = True

    def _count(self, item, sign):
        self.counts['images' if item.kind == formats.IMAGE else 'videos'] += sign
        self.counts['bytes'] += sign * item.size
        if item.probed:
            self.counts['probed'] += sign

    def apply_probe(self, item_id, version, meta, birth):
        with self.lock:
            item = self.items[item_id]
            if not item.alive or item.version != version or item.probed:
                return False
            item.apply_meta(meta, birth)
            self.counts['probed'] += 1
            self._stamp(item)
            return True

    def commit(self):
        """Publish pending changes as a new revision. True when there were any."""
        with self.lock:
            if not self.dirty:
                return False
            self.rev += 1
            self.dirty = False
            return True

    # --- reading -------------------------------------------------------------

    def get(self, item_id):
        with self.lock:
            if 0 <= item_id < len(self.items):
                item = self.items[item_id]
                if item.alive:
                    return item
        return None

    def path_of(self, item):
        parts = item.folder.rel.split('/') if item.folder.rel else []
        return os.path.join(self.real_root, *parts, item.name)

    def summary(self):
        with self.lock:
            return {
                'items': self.counts['images'] + self.counts['videos'],
                'images': self.counts['images'],
                'videos': self.counts['videos'],
                'bytes': self.counts['bytes'],
                'probed': self.counts['probed'],
                'folders': sum(1 for folder in self.folders if folder.alive),
            }

    def delta(self, since):
        """Everything that changed after revision `since` (0: everything)."""
        with self.lock:
            full = since <= 0 or since > self.rev
            if full:
                since = 0
            return {
                'rev': self.rev,
                'full': full,
                'folders': [folder.wire() for folder in self.folders if folder.alive and folder.rev > since],
                'items': [item.wire() for item in self.items if item.alive and item.rev > since],
                'removedFolders': [] if full else [fid for rev, fid in self.removed_folders if rev > since],
                'removedItems': [] if full else [iid for rev, iid in self.removed_items if rev > since],
            }
