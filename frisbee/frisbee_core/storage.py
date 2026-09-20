"""Filesystem services independent of HTTP, browsers, and background job queues.

API paths are Unicode paths relative to a selected root, using forward slashes.
Every access checks both the lexical path and its resolved symlink destination.
The shared file-store lock lets background jobs coordinate with normal requests.
"""
from __future__ import absolute_import, unicode_literals

import codecs
import errno
import functools
import hashlib
import ntpath
import os
import stat
import tempfile
import threading
import uuid
import zipfile

from .compat import (assert_resolvable, atomic_replace, ensure_directory, fs_text,
                     is_linklike, safe_remove_tree, string_types, text_type)


class StorageError(Exception):
    """An expected filesystem failure with an HTTP-friendly status code."""

    def __init__(self, message, status=400):
        self.message = fs_text(message)
        self.status = status
        Exception.__init__(self, self.message)


def _friendly_error(exc):
    number = getattr(exc, "errno", None)
    if number in (errno.EACCES, errno.EPERM):
        return StorageError("Permission denied: " + fs_text(exc), 403)
    if number in (errno.ENOENT, errno.ENOTDIR):
        return StorageError("Path does not exist: " + fs_text(exc), 404)
    if number in (errno.EEXIST, errno.ENOTEMPTY):
        return StorageError("The destination already exists: " + fs_text(exc), 409)
    return StorageError("Filesystem operation failed: " + fs_text(exc), 400)


def filesystem_errors(method):
    """Translate only expected operating-system failures, preserving code errors."""
    @functools.wraps(method)
    def wrapped(*args, **kwargs):
        try:
            return method(*args, **kwargs)
        except (IOError, OSError) as exc:
            raise _friendly_error(exc)
        except UnicodeError:
            raise StorageError("The filename or text has an unsupported encoding.", 400)
    return wrapped


def normalize_relative(path):
    """Validate a portable API path without silently accepting traversal."""
    if not isinstance(path, string_types):
        raise StorageError("The path must be a string.")
    path = fs_text(path)
    if "\x00" in path or "\\" in path or path.startswith("/") or ntpath.splitdrive(path)[0]:
        raise StorageError("Use a relative path with forward slashes.")
    parts = path.split("/")
    if ".." in parts:
        raise StorageError("Parent traversal is not allowed.", 403)
    if os.name == "nt":
        for part in parts:
            if part not in ("", "."):
                _windows_name(part)
    return "/".join(part for part in parts if part not in ("", "."))


def _windows_name(name):
    """Reject Windows devices, alternate streams, and ambiguous path aliases."""
    if any(ord(character) < 32 or character in '<>:"|?*' for character in name):
        raise StorageError("The name contains characters unsupported by Windows.")
    if name.endswith((" ", ".")):
        raise StorageError("A name cannot end with a space or period.")
    stem = name.split(".", 1)[0].rstrip(" ").upper()
    devices = ("CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$")
    numbered = len(stem) == 4 and stem[:3] in ("COM", "LPT") and stem[3] in "123456789\u00b9\u00b2\u00b3"
    if stem in devices or numbered:
        raise StorageError("This name is reserved for a Windows device.")


def _single_name(name):
    if not isinstance(name, string_types):
        raise StorageError("The name must be a string.")
    name = fs_text(name)
    if not name or name in (".", "..") or any(char in name for char in ("/", "\\", "\x00")):
        raise StorageError("Enter a single filename without path separators.")
    if ntpath.splitdrive(name)[0]:
        raise StorageError("A filename cannot contain a drive prefix.")
    if os.name == "nt":
        _windows_name(name)
    return name


def _join_relative(parent, name):
    return parent + "/" + name if parent else name


def _inside(root, path):
    """Use a separator boundary rather than a vulnerable plain string prefix."""
    root = os.path.normcase(os.path.abspath(root))
    path = os.path.normcase(os.path.abspath(path))
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _revision(data):
    return hashlib.sha256(data).hexdigest()


_TEXT_BOMS = ((codecs.BOM_UTF32_LE, "utf-32-le"),
              (codecs.BOM_UTF32_BE, "utf-32-be"),
              (codecs.BOM_UTF16_LE, "utf-16-le"),
              (codecs.BOM_UTF16_BE, "utf-16-be"),
              (codecs.BOM_UTF8, "utf-8"))


def _decode_text(data):
    # Byte-order marks let UTF-16/32 documents remain editable without guessing
    # an encoding for arbitrary executable or other binary data.
    for marker, encoding in _TEXT_BOMS:
        if data.startswith(marker):
            try:
                return data[len(marker):].decode(encoding), encoding
            except UnicodeError:
                raise StorageError("This file contains invalid Unicode text.", 415)
    if b"\x00" in data:
        raise StorageError("This file contains binary data.", 415)
    try:
        return data.decode("utf-8"), "utf-8"
    except UnicodeError:
        raise StorageError("This file is not UTF-8 or BOM-marked Unicode text.", 415)


def _encode_text(content, encoding, original):
    """Keep the document's byte order and BOM when edited on a different host."""
    for marker, marker_encoding in _TEXT_BOMS:
        if original.startswith(marker):
            return marker + content.encode(marker_encoding)
    return content.encode(encoding)


def _publish_upload(temporary, destination):
    """Publish a finished upload without replacing another Frisbee upload."""
    if hasattr(os, "link") and os.name != "nt":
        try:
            os.link(temporary, destination)
            os.unlink(temporary)
            return
        except OSError as exc:
            unavailable = (errno.EPERM, getattr(errno, "EOPNOTSUPP", errno.EPERM),
                           getattr(errno, "ENOTSUP", errno.EPERM), getattr(errno, "ENOSYS", errno.EPERM))
            if exc.errno not in unavailable:
                raise
    # Windows rename refuses existing targets. On POSIX filesystems without
    # hardlinks (for example FAT), the caller's lock serializes Frisbee writers;
    # the final existence check also protects files created before publication.
    if os.path.lexists(destination):
        raise StorageError("The destination already exists.", 409)
    os.rename(temporary, destination)


def _write_atomic(path, data, existing_mode=None):
    """Write beside the target so that the final replacement stays atomic."""
    descriptor, temporary = tempfile.mkstemp(prefix=".frisbee-", suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if existing_mode is not None:
            os.chmod(temporary, existing_mode)
        atomic_replace(temporary, path)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


class WorkspaceStore(object):
    """Keep independent browser workspaces without changing the process cwd."""

    def __init__(self, base_dir):
        self.base_dir = os.path.abspath(fs_text(base_dir))
        self._workspaces = {}
        self._lock = threading.RLock()

    @filesystem_errors
    def create(self, mode, path=None):
        if mode == "local":
            root = os.path.join(self.base_dir, "workspace")
        elif mode == "absolute":
            if not isinstance(path, string_types) or not os.path.isabs(fs_text(path)):
                raise StorageError("Enter an absolute directory path.")
            root = fs_text(path)
        elif mode == "host":
            root = (os.environ.get("SystemDrive", "C:") + os.sep) if os.name == "nt" else os.sep
        else:
            raise StorageError("Unknown workspace mode.")
        assert_resolvable(root)
        if mode == "local":
            ensure_directory(root)
        root = os.path.realpath(os.path.abspath(root))
        if not os.path.isdir(root):
            raise StorageError("The workspace must be an existing directory.", 404)
        if not os.access(root, os.R_OK):
            raise StorageError("The workspace directory is not readable.", 403)
        # Listing is the actual access check; access() alone does not cover ACLs.
        os.listdir(root)
        workspace = {"id": uuid.uuid4().hex, "root": root, "mode": mode}
        with self._lock:
            self._workspaces[workspace["id"]] = workspace
        return dict(workspace)

    def get(self, workspace_id):
        if not isinstance(workspace_id, string_types):
            raise StorageError("Select a workspace first.", 404)
        with self._lock:
            workspace = self._workspaces.get(workspace_id)
            if workspace is None:
                raise StorageError("The workspace no longer exists. Select it again.", 404)
            return dict(workspace)

    @filesystem_errors
    def resolve(self, workspace_id, relative="", must_exist=True):
        relative = normalize_relative(relative)
        root = self.get(workspace_id)["root"]
        path = os.path.abspath(os.path.join(root, *relative.split("/"))) if relative else root
        assert_resolvable(path)
        if not _inside(root, path) or not _inside(root, os.path.realpath(path)):
            raise StorageError("The path or symbolic link leaves this workspace.", 403)
        if must_exist and not os.path.lexists(path):
            raise StorageError("The path no longer exists.", 404)
        # Return the lexical path: unlinking or renaming an internal symlink must
        # affect the link itself, not the file to which it points.
        return path


class FileStore(object):
    """Composable file operations; HTTP transport only provides streams and paths."""

    # Keep preview classification and HTTP media types together: system MIME
    # databases differ, notably for M4V. These are containers the browser may
    # attempt to play; recognizing one does not imply codec support or decoding.
    MEDIA_TYPES = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
        ".svg": "image/svg+xml", ".ico": "image/x-icon", ".avif": "image/avif",
        ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
        ".ogv": "video/ogg", ".mov": "video/quicktime", ".qt": "video/quicktime",
        ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
        ".mpeg": "video/mpeg", ".mpg": "video/mpeg", ".mpe": "video/mpeg",
        ".m1v": "video/mpeg", ".m2v": "video/mpeg", ".vob": "video/mpeg",
        ".3gp": "video/3gpp", ".3gpp": "video/3gpp", ".3g2": "video/3gpp2",
        ".mts": "video/mp2t", ".m2ts": "video/mp2t",
        ".wmv": "video/x-ms-wmv", ".asf": "video/x-ms-asf", ".flv": "video/x-flv",
    }
    # Ambiguous .ts and .ogg extensions are intentionally absent: ordinary
    # TypeScript remains editable, and Ogg audio is not mislabeled as video.
    IMAGE_EXTENSIONS = frozenset(extension for extension, mime in MEDIA_TYPES.items() if mime.startswith("image/"))
    VIDEO_EXTENSIONS = frozenset(extension for extension, mime in MEDIA_TYPES.items() if mime.startswith("video/"))
    BINARY_EXTENSIONS = frozenset((".exe", ".msi", ".appimage", ".dll", ".so", ".dylib", ".bin", ".zip", ".gz", ".7z", ".rar", ".tar", ".pdf", ".mp3", ".woff", ".woff2"))

    def __init__(self, workspaces):
        self.workspaces = workspaces
        self.lock = threading.RLock()

    @classmethod
    def media_type(cls, name):
        """Return a stable preview MIME type, or None for non-preview media."""
        return cls.MEDIA_TYPES.get(os.path.splitext(name)[1].lower())

    def _preview(self, path, name):
        extension = os.path.splitext(name)[1].lower()
        media_type = self.media_type(name)
        if media_type is not None:
            return media_type.split("/", 1)[0]
        if extension in self.BINARY_EXTENSIONS:
            return "binary"
        try:
            with open(path, "rb") as handle:
                sample = handle.read(8192)
            if sample.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE, codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
                return "text"
            if b"\x00" in sample:
                return "binary"
            # Incremental decoding accepts a sample ending midway through a
            # multibyte character while still rejecting invalid UTF-8 bytes.
            decoded = codecs.getincrementaldecoder("utf-8-sig")().decode(sample, final=False)
            if any(ord(character) < 32 and character not in "\n\r\t\f\b" for character in decoded):
                return "binary"
            return "text"
        except (OSError, IOError, UnicodeError):
            return "binary"

    def _entry(self, workspace_id, parent, name):
        relative = _join_relative(parent, name)
        entry = {"name": name, "path": relative, "kind": "other", "size": None,
                 "created": None, "file_count": None, "readable": False,
                 "is_link": False, "preview": "binary"}
        lexical = os.path.join(self.workspaces.resolve(workspace_id, parent), name)
        try:
            entry["is_link"] = is_linklike(lexical)
            path = self.workspaces.resolve(workspace_id, relative)
            info = os.stat(path)
            if stat.S_ISDIR(info.st_mode):
                entry["kind"] = "directory"
                if os.access(path, os.R_OK):
                    children = os.listdir(path)
                    count = 0
                    for child in children:
                        try:
                            child_path = self.workspaces.resolve(workspace_id, _join_relative(relative, fs_text(child)))
                            if os.path.isfile(child_path):
                                count += 1
                        except StorageError:
                            continue
                    entry["file_count"] = count
                    entry["readable"] = True
            elif stat.S_ISREG(info.st_mode):
                entry["kind"] = "file"
                entry["size"] = info.st_size
                entry["readable"] = os.access(path, os.R_OK)
                entry["preview"] = self._preview(path, name)
            entry["created"] = getattr(info, "st_birthtime", info.st_ctime if os.name == "nt" else None)
        except (StorageError, OSError, IOError):
            # An inaccessible entry is still useful in the listing. Do not read
            # through a blocked symlink just to populate optional metadata.
            pass
        return entry

    @filesystem_errors
    def list(self, workspace_id, path=""):
        path = normalize_relative(path)
        with self.lock:
            absolute = self.workspaces.resolve(workspace_id, path)
            if not os.path.isdir(absolute):
                raise StorageError("The selected path is not a directory.")
            entries = [self._entry(workspace_id, path, fs_text(name)) for name in os.listdir(absolute)]
            entries.sort(key=lambda entry: (entry["kind"] != "directory", entry["name"].lower(), entry["name"]))
            parent = path.rsplit("/", 1)[0] if "/" in path else ""
            return {"path": path, "parent": parent if path else None, "entries": entries}

    @filesystem_errors
    def raw_file(self, workspace_id, path):
        with self.lock:
            absolute = self.workspaces.resolve(workspace_id, path)
            if not os.path.isfile(absolute):
                raise StorageError("The selected path is not a regular file.")
            return absolute

    @filesystem_errors
    def content(self, workspace_id, path):
        path = normalize_relative(path)
        with self.lock:
            absolute = self.raw_file(workspace_id, path)
            with open(absolute, "rb") as handle:
                data = handle.read()
            content, unused_encoding = _decode_text(data)
            return {"path": path, "content": content, "revision": _revision(data)}

    @filesystem_errors
    def save_content(self, workspace_id, path, content, revision=None):
        path = normalize_relative(path)
        if not isinstance(content, text_type):
            raise StorageError("Text content must be a Unicode string.")
        with self.lock:
            absolute = self.raw_file(workspace_id, path)
            with open(absolute, "rb") as handle:
                original = handle.read()
            if revision is not None and revision != _revision(original):
                raise StorageError("The file changed since it was opened. Reload before saving.", 409)
            unused_content, encoding = _decode_text(original)
            data = _encode_text(content, encoding, original)
            # Resolve a valid internal symlink before replacement so editing it
            # updates its target instead of replacing the link with a new file.
            target = os.path.realpath(absolute)
            _write_atomic(target, data, stat.S_IMODE(os.stat(target).st_mode))
            return {"path": path, "content": content, "revision": _revision(data)}

    @filesystem_errors
    def rename(self, workspace_id, path, name):
        path = normalize_relative(path)
        name = _single_name(name)
        if not path:
            raise StorageError("The workspace root cannot be renamed.", 403)
        parent = path.rsplit("/", 1)[0] if "/" in path else ""
        destination = _join_relative(parent, name)
        with self.lock:
            source = self.workspaces.resolve(workspace_id, path)
            target = self.workspaces.resolve(workspace_id, destination, must_exist=False)
            if source == target:
                return {"path": destination}
            if os.path.lexists(target):
                raise StorageError("The destination already exists.", 409)
            os.rename(source, target)
            return {"path": destination}

    def _selection(self, paths):
        if not isinstance(paths, (list, tuple)) or not paths:
            raise StorageError("Select one or more files or directories.")
        normalized = []
        for path in paths:
            path = normalize_relative(path)
            if not path:
                raise StorageError("The workspace root cannot be selected.", 403)
            if path not in normalized:
                normalized.append(path)
        # Selecting a folder already includes all selected descendants.
        return [path for path in normalized if not any(path.startswith(other + "/") for other in normalized if other != path)]

    @filesystem_errors
    def delete(self, workspace_id, paths):
        paths = self._selection(paths)
        deleted, errors = [], []
        with self.lock:
            for path in paths:
                try:
                    absolute = self.workspaces.resolve(workspace_id, path)
                    safe_remove_tree(absolute)
                    deleted.append(path)
                except StorageError as exc:
                    errors.append(path + ": " + exc.message)
                except (OSError, IOError) as exc:
                    errors.append(path + ": " + _friendly_error(exc).message)
        return {"deleted": deleted, "errors": errors}

    @filesystem_errors
    def create_directory(self, workspace_id, path, name):
        path = normalize_relative(path)
        relative = _join_relative(path, _single_name(name))
        with self.lock:
            parent = self.workspaces.resolve(workspace_id, path)
            if not os.path.isdir(parent):
                raise StorageError("The parent path is not a directory.")
            absolute = self.workspaces.resolve(workspace_id, relative, must_exist=False)
            if os.path.lexists(absolute):
                raise StorageError("The destination already exists.", 409)
            os.mkdir(absolute)
        return {"path": relative}

    @filesystem_errors
    def build_zip(self, workspace_id, paths):
        paths = self._selection(paths)
        temporary = tempfile.TemporaryFile(mode="w+b")
        try:
            with self.lock:
                # Relative names preserve the selected paths and prevent equal
                # basenames from different directories colliding in the archive.
                compression = zipfile.ZIP_DEFLATED if zipfile.zlib else zipfile.ZIP_STORED
                with zipfile.ZipFile(temporary, "w", compression=compression, allowZip64=True) as archive:
                    for path in paths:
                        self._zip_entry(archive, workspace_id, path, set())
            temporary.seek(0)
            return temporary
        except Exception:
            temporary.close()
            raise

    def _zip_entry(self, archive, workspace_id, relative, ancestors):
        absolute = self.workspaces.resolve(workspace_id, relative)
        if os.path.isdir(absolute):
            canonical = os.path.normcase(os.path.realpath(absolute))
            if canonical in ancestors:
                raise StorageError("A symbolic link creates a directory cycle: " + relative, 409)
            ancestors = ancestors | set((canonical,))
            directory = zipfile.ZipInfo(relative.rstrip("/") + "/")
            directory.external_attr = (0o40755 << 16) | 0x10
            directory.create_system = 3
            archive.writestr(directory, b"")
            for name in sorted(os.listdir(absolute)):
                self._zip_entry(archive, workspace_id, _join_relative(relative, fs_text(name)), ancestors)
        elif os.path.isfile(absolute):
            # zipfile.write streams chunks on both Python 2.7 and Python 3.
            archive.write(absolute, relative)
        else:
            raise StorageError("Only regular files and directories can be archived: " + relative)

    @filesystem_errors
    def receive_upload(self, workspace_id, path, relative_name, stream, length):
        path = normalize_relative(path)
        if not isinstance(relative_name, string_types):
            raise StorageError("The upload name must be a string.")
        is_directory = fs_text(relative_name).endswith("/")
        relative_name = normalize_relative(relative_name)
        if not relative_name:
            raise StorageError("The uploaded file needs a name.")
        if isinstance(length, bool) or not isinstance(length, (int,)):
            # Python 2 represents large Content-Length values as long.
            try:
                valid_length = isinstance(length, long) and not isinstance(length, bool)
            except NameError:
                valid_length = False
            if not valid_length:
                raise StorageError("The upload length must be an integer.")
        if length < 0:
            raise StorageError("The upload length cannot be negative.")
        relative = _join_relative(path, relative_name)
        with self.lock:
            parent = self.workspaces.resolve(workspace_id, path)
            if not os.path.isdir(parent):
                raise StorageError("The upload destination is not a directory.")
            absolute = self.workspaces.resolve(workspace_id, relative, must_exist=False)
            if is_directory:
                if length:
                    raise StorageError("A directory upload must have an empty body.")
                ensure_directory(absolute)
                return {"path": relative, "size": 0}
            if os.path.lexists(absolute):
                raise StorageError("The destination already exists; rename it before uploading.", 409)
            ensure_directory(os.path.dirname(absolute))
            # Recheck after directory creation in case the filesystem changed.
            self.workspaces.resolve(workspace_id, relative, must_exist=False)
            descriptor, temporary = tempfile.mkstemp(prefix=".frisbee-upload-", suffix=".tmp", dir=os.path.dirname(absolute))
            try:
                remaining = length
                with os.fdopen(descriptor, "wb") as handle:
                    while remaining:
                        chunk = stream.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise StorageError("The upload ended before all bytes arrived.")
                        if len(chunk) > remaining:
                            raise StorageError("The upload stream exceeded its declared length.")
                        handle.write(chunk)
                        remaining -= len(chunk)
                    handle.flush()
                    os.fsync(handle.fileno())
                self.workspaces.resolve(workspace_id, relative, must_exist=False)
                _publish_upload(temporary, absolute)
                return {"path": relative, "size": length}
            finally:
                if os.path.lexists(temporary):
                    os.unlink(temporary)


class NoteStore(object):
    """Project-local plain-text notes that do not depend on a workspace session."""

    def __init__(self, base_dir):
        assert_resolvable(os.path.abspath(fs_text(base_dir)))
        self.root = os.path.join(os.path.realpath(os.path.abspath(fs_text(base_dir))), "notepad")
        self.lock = threading.RLock()
        assert_resolvable(self.root)
        ensure_directory(self.root)

    def _path(self, name):
        name = _single_name(name)
        _windows_name(name)
        path = os.path.join(self.root, name + ".txt")
        assert_resolvable(path)
        if is_linklike(path) or not _inside(self.root, os.path.realpath(path)):
            raise StorageError("Notes cannot be symbolic links.", 403)
        return name, path

    @filesystem_errors
    def list(self):
        with self.lock:
            assert_resolvable(self.root)
            ensure_directory(self.root)
            notes = []
            for filename in os.listdir(self.root):
                filename = fs_text(filename)
                if not filename.endswith(".txt"):
                    continue
                try:
                    name, path = self._path(filename[:-4])
                    info = os.stat(path)
                    if stat.S_ISREG(info.st_mode):
                        notes.append({"name": name, "size": info.st_size, "modified": info.st_mtime})
                except (StorageError, OSError, IOError):
                    continue
            notes.sort(key=lambda note: (note["name"].lower(), note["name"]))
            return {"notes": notes}

    @filesystem_errors
    def get(self, name):
        with self.lock:
            name, path = self._path(name)
            with open(path, "rb") as handle:
                data = handle.read()
            content, unused_encoding = _decode_text(data)
            return {"name": name, "content": content, "revision": _revision(data)}

    @filesystem_errors
    def save(self, name, content, revision=None, create=False):
        if not isinstance(content, text_type):
            raise StorageError("Note content must be a Unicode string.")
        with self.lock:
            assert_resolvable(self.root)
            ensure_directory(self.root)
            name, path = self._path(name)
            exists = os.path.lexists(path)
            if create and exists:
                raise StorageError("A note with this name already exists.", 409)
            if not create and not exists:
                raise StorageError("The note no longer exists.", 404)
            mode = None
            if exists:
                with open(path, "rb") as handle:
                    original = handle.read()
                if revision is not None and revision != _revision(original):
                    raise StorageError("The note changed since it was opened. Reload before saving.", 409)
                mode = stat.S_IMODE(os.stat(path).st_mode)
            data = content.encode("utf-8")
            _write_atomic(path, data, mode)
            return {"name": name, "content": content, "revision": _revision(data)}

    @filesystem_errors
    def delete(self, name):
        with self.lock:
            name, path = self._path(name)
            os.unlink(path)
            return {"deleted": name}
