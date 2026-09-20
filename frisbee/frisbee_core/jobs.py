# -*- coding: utf-8 -*-
"""Background file moves with observable progress and safe cross-volume copies."""
from __future__ import unicode_literals

import errno
import os
import shutil
import stat
import threading
import time
import uuid

from .compat import is_linklike, safe_remove_tree, string_types
from .storage import StorageError


class JobStore(object):
    """Keep progress outside the filesystem lock so polling stays responsive."""

    def __init__(self, file_store):
        self.files = file_store
        self.workspaces = file_store.workspaces
        self.lock = threading.RLock()
        self.jobs = {}
        self.threads = []

    def get(self, identifier):
        with self.lock:
            if identifier not in self.jobs:
                raise StorageError('This move job no longer exists.', 404)
            result = dict(self.jobs[identifier])
            result['errors'] = list(result['errors'])
            return result

    def _update(self, identifier, **values):
        with self.lock:
            self.jobs[identifier].update(values)

    def _advance(self, identifier, amount):
        with self.lock:
            self.jobs[identifier]['bytes_done'] += amount

    def start(self, workspace, paths, destination):
        if not isinstance(paths, list) or not paths:
            raise StorageError('Select at least one file or directory.')
        if not isinstance(destination, string_types):
            raise StorageError('The destination must be a workspace-relative path.')
        destination_abs = self.workspaces.resolve(workspace, destination)
        if not os.path.isdir(destination_abs):
            raise StorageError('The destination is not a directory.')
        # Collapse descendants when the parent is also selected. Otherwise the
        # same item could be moved twice, or become missing halfway through a job.
        normalized = []
        for path in paths:
            absolute = self.workspaces.resolve(workspace, path)
            root = self.workspaces.get(workspace)['root']
            relative = os.path.relpath(absolute, root).replace(os.sep, '/')
            if relative == '.':
                raise StorageError('The workspace root cannot be moved.')
            normalized.append(relative)
        selected = []
        for path in sorted(set(normalized), key=lambda item: (item.count('/'), item)):
            if not any(path.startswith(parent + '/') for parent in selected):
                selected.append(path)
        identifier = uuid.uuid4().hex
        with self.lock:
            # Expiration bounds metadata growth without setting a limit on files.
            expired = [key for key, value in self.jobs.items()
                       if value['status'] != 'running' and time.time() - value['updated'] > 86400]
            for key in expired:
                del self.jobs[key]
            self.jobs[identifier] = {'id': identifier, 'status': 'running',
                                    'completed': 0, 'total': len(selected),
                                    'bytes_done': 0, 'bytes_total': 0,
                                    'errors': [], 'message': 'Preparing move...',
                                    'updated': time.time()}
            self.threads = [thread for thread in self.threads if thread.is_alive()]
            worker = threading.Thread(target=self._run, args=(identifier, workspace, selected, destination))
            worker.daemon = True
            self.threads.append(worker)
            worker.start()
        return self.get(identifier)

    def _size(self, path):
        info = os.lstat(path)
        if is_linklike(path):
            if os.name == 'nt' and not (hasattr(os, 'readlink') and hasattr(os, 'symlink')):
                raise StorageError('This Python version cannot safely move Windows reparse points.')
            return 0
        if stat.S_ISREG(info.st_mode):
            return info.st_size
        if stat.S_ISDIR(info.st_mode):
            return sum(self._size(os.path.join(path, name)) for name in os.listdir(path))
        raise StorageError('Special device files and sockets cannot be moved.')

    def _copy(self, identifier, source, target):
        """Copy to an unpublished temporary path; never remove the source here."""
        info = os.lstat(source)
        if is_linklike(source):
            # Preserve link identity, including relative link targets.
            if os.name == 'nt':
                os.symlink(os.readlink(source), target, target_is_directory=os.path.isdir(source))
            else:
                os.symlink(os.readlink(source), target)
        elif stat.S_ISDIR(info.st_mode):
            os.mkdir(target)
            for name in os.listdir(source):
                self._copy(identifier, os.path.join(source, name), os.path.join(target, name))
            shutil.copystat(source, target)
        elif stat.S_ISREG(info.st_mode):
            with open(source, 'rb') as reader:
                with open(target, 'wb') as writer:
                    while True:
                        chunk = reader.read(1024 * 1024)
                        if not chunk:
                            break
                        writer.write(chunk)
                        self._advance(identifier, len(chunk))
                    writer.flush()
                    os.fsync(writer.fileno())
            shutil.copystat(source, target)
        else:
            raise StorageError('Special device files and sockets cannot be moved.')

    @staticmethod
    def _remove(path):
        safe_remove_tree(path)

    def _move(self, identifier, source, target, size):
        if os.path.lexists(target):
            raise StorageError('The destination already contains %s.' % os.path.basename(target), 409)
        try:
            os.rename(source, target)
            self._advance(identifier, size)
            return
        except OSError as error:
            if error.errno != errno.EXDEV and getattr(error, 'winerror', None) != 17:
                raise
        # Cross-volume renames are impossible. Publish a complete copy first,
        # and delete the original only after that copy has succeeded.
        temporary = os.path.join(os.path.dirname(target), '.frisbee-move-' + uuid.uuid4().hex)
        try:
            self._copy(identifier, source, temporary)
            if os.path.lexists(target):
                raise StorageError('The destination was created by another process.', 409)
            os.rename(temporary, target)
        finally:
            if os.path.lexists(temporary):
                self._remove(temporary)
        try:
            self._remove(source)
        except (OSError, IOError) as error:
            raise StorageError('Copy completed, but the original could not be removed: %s' % error)

    def _run(self, identifier, workspace, paths, destination):
        errors = []
        try:
            with self.files.lock:
                destination_abs = self.workspaces.resolve(workspace, destination)
                plan = []
                targets = set()
                for path in paths:
                    source = self.workspaces.resolve(workspace, path)
                    target = os.path.join(destination_abs, os.path.basename(source))
                    source_real = os.path.normcase(os.path.realpath(source))
                    target_real = os.path.normcase(os.path.realpath(target))
                    if target_real == source_real or target_real.startswith(source_real + os.sep):
                        raise StorageError('A directory cannot be moved into itself or one of its descendants.')
                    if os.path.lexists(target) or os.path.normcase(target) in targets:
                        raise StorageError('The destination already contains %s.' % os.path.basename(target), 409)
                    targets.add(os.path.normcase(target))
                    plan.append((source, target, self._size(source)))
                self._update(identifier, bytes_total=sum(item[2] for item in plan), message='Moving files...')
                for index, (source, target, size) in enumerate(plan):
                    try:
                        self._update(identifier, message='Moving %s' % os.path.basename(source))
                        self._move(identifier, source, target, size)
                    except (OSError, IOError, StorageError) as error:
                        errors.append('%s: %s' % (os.path.basename(source), error))
                    self._update(identifier, completed=index + 1, errors=list(errors), updated=time.time())
        except Exception as error:
            errors.append('%s' % error)
        self._update(identifier, status='error' if errors else 'done', errors=errors,
                     message='Move finished with errors.' if errors else 'Move complete.', updated=time.time())

    def close(self):
        # A normal Ctrl+C waits for copies to finish, protecting the source files.
        for thread in self.threads:
            thread.join()
