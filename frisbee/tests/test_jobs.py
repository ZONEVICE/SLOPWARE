"""Verify same-volume moves and the cross-volume recovery guarantees."""
from __future__ import absolute_import, unicode_literals

import errno
import io
import os
import time

from tests.support import TemporaryDirectoryTestCase
from frisbee_core import jobs as jobs_module
from frisbee_core.jobs import JobStore
from frisbee_core.storage import FileStore, WorkspaceStore


class MoveTests(TemporaryDirectoryTestCase):
    def setUp(self):
        TemporaryDirectoryTestCase.setUp(self)
        self.workspaces = WorkspaceStore(self.base_dir)
        self.workspace = self.workspaces.create("local")
        self.files = FileStore(self.workspaces)
        self.jobs = JobStore(self.files)
        self.addCleanup(self.jobs.close)
        os.mkdir(os.path.join(self.workspace["root"], "destination"))

    def finish(self, job):
        deadline = time.time() + 10
        while time.time() < deadline:
            latest = self.jobs.get(job["id"])
            if latest["status"] != "running":
                return latest
            time.sleep(0.01)
        self.fail("The move job never completed.")

    def force_cross_volume(self, source):
        """Fail only the initial rename; publishing the temporary copy still works."""
        original_rename = jobs_module.os.rename

        def rename(first, second):
            if first == source:
                raise OSError(errno.EXDEV, "Simulated cross-volume rename")
            return original_rename(first, second)

        jobs_module.os.rename = rename
        self.addCleanup(setattr, jobs_module.os, "rename", original_rename)

    def test_cross_volume_directory_move_preserves_bytes_and_empty_directory(self):
        content = b"\x00\x01\xfe\xff" * 350000
        self.write_file("workspace/source/deep/file.bin", content)
        os.mkdir(os.path.join(self.workspace["root"], "source", "empty"))
        source = os.path.join(self.workspace["root"], "source")
        self.force_cross_volume(source)
        result = self.finish(self.jobs.start(self.workspace["id"], ["source"], "destination"))
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["bytes_total"], len(content))
        self.assertEqual(result["bytes_done"], len(content))
        self.assertEqual(result["completed"], 1)
        self.assertFalse(os.path.exists(source))
        self.assertEqual(self.read_file("workspace/destination/source/deep/file.bin"), content)
        self.assertTrue(os.path.isdir(os.path.join(self.workspace["root"], "destination", "source", "empty")))

    def test_failed_cross_volume_copy_preserves_original_and_removes_partial_copy(self):
        source = self.write_file("workspace/source.bin", b"original bytes")
        self.force_cross_volume(source)

        def failed_copy(identifier, first, second):
            with io.open(second, "wb") as handle:
                handle.write(b"partial")
            raise IOError(errno.ENOSPC, "Simulated full destination volume")

        self.jobs._copy = failed_copy
        result = self.finish(self.jobs.start(self.workspace["id"], ["source.bin"], "destination"))
        self.assertEqual(result["status"], "error")
        self.assertTrue(result["errors"])
        self.assertEqual(self.read_file("workspace/source.bin"), b"original bytes")
        self.assertEqual(os.listdir(os.path.join(self.workspace["root"], "destination")), [])

    def test_destination_conflict_does_not_overwrite_either_file(self):
        self.write_file("workspace/shared.txt", b"source")
        self.write_file("workspace/destination/shared.txt", b"destination")
        result = self.finish(self.jobs.start(self.workspace["id"], ["shared.txt"], "destination"))
        self.assertEqual(result["status"], "error")
        self.assertEqual(self.read_file("workspace/shared.txt"), b"source")
        self.assertEqual(self.read_file("workspace/destination/shared.txt"), b"destination")

    def test_directory_cannot_move_into_its_own_descendant(self):
        self.write_file("workspace/folder/nested/file.txt", b"keep")
        result = self.finish(self.jobs.start(self.workspace["id"], ["folder"], "folder/nested"))
        self.assertEqual(result["status"], "error")
        self.assertEqual(self.read_file("workspace/folder/nested/file.txt"), b"keep")

    def test_parent_and_child_selection_are_not_moved_twice(self):
        self.write_file("workspace/folder/file.txt", b"once")
        result = self.finish(self.jobs.start(self.workspace["id"], ["folder", "folder/file.txt"], "destination"))
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["total"], 1)
        self.assertEqual(self.read_file("workspace/destination/folder/file.txt"), b"once")

    def test_cross_volume_move_preserves_symlinks_without_copying_their_targets(self):
        if os.name == "nt" or not hasattr(os, "symlink"):
            self.skipTest("This regression exercises POSIX symbolic links.")
        source_file = self.write_file("workspace/source/file.txt", b"source bytes")
        external_file = self.write_file("external/keep.txt", b"external bytes")
        source = os.path.dirname(source_file)
        os.symlink("file.txt", os.path.join(source, "relative-link"))
        os.symlink(os.path.dirname(external_file), os.path.join(source, "external-link"))
        self.force_cross_volume(source)
        result = self.finish(self.jobs.start(self.workspace["id"], ["source"], "destination"))
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["bytes_total"], len(b"source bytes"))
        self.assertEqual(result["bytes_done"], result["bytes_total"])
        destination = os.path.join(self.workspace["root"], "destination", "source")
        self.assertTrue(os.path.islink(os.path.join(destination, "relative-link")))
        self.assertEqual(os.readlink(os.path.join(destination, "relative-link")), "file.txt")
        self.assertTrue(os.path.islink(os.path.join(destination, "external-link")))
        self.assertEqual(os.readlink(os.path.join(destination, "external-link")), os.path.dirname(external_file))
        self.assertEqual(self.read_file("external/keep.txt"), b"external bytes")
        self.assertEqual(self.read_file("workspace/destination/source/file.txt"), b"source bytes")
        self.assertFalse(os.path.exists(source))
