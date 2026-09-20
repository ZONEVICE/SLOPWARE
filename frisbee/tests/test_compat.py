"""Cross-platform link handling without requiring a Windows test host."""
from __future__ import absolute_import, unicode_literals

import errno
import ntpath
import os

from tests.support import TemporaryDirectoryTestCase
from frisbee_core import compat
from frisbee_core.storage import FileStore, WorkspaceStore


class Namespace(object):
    """Provide isolated module stand-ins without changing the real os module."""

    def __init__(self, **attributes):
        self.__dict__.update(attributes)


class CompatibilityTests(TemporaryDirectoryTestCase):
    def replace_attribute(self, target, name, value):
        original = getattr(target, name)
        self.addCleanup(setattr, target, name, original)
        setattr(target, name, value)

    def test_delete_tree_preserves_external_directory_symlink_target(self):
        if os.name == "nt" or not hasattr(os, "symlink"):
            self.skipTest("This regression exercises POSIX symbolic links.")
        workspace_store = WorkspaceStore(self.base_dir)
        workspace = workspace_store.create("local")
        files = FileStore(workspace_store)
        external_file = self.write_file("external/keep.txt", b"must survive")
        self.write_file("workspace/selected/nested/local.txt", b"remove me")
        directory = os.path.join(workspace["root"], "selected", "nested")
        os.symlink(os.path.dirname(external_file), os.path.join(directory, "external-directory"))
        os.symlink(os.path.join(self.base_dir, "missing-target"), os.path.join(directory, "broken-link"))
        result = files.delete(workspace["id"], ["selected"])
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["deleted"], ["selected"])
        self.assertFalse(os.path.lexists(os.path.join(workspace["root"], "selected")))
        self.assertEqual(self.read_file("external/keep.txt"), b"must survive")

    def test_old_windows_rejects_reparse_ancestor_before_traversal(self):
        junction = "C:\\selected\\junction"
        descendant = junction + "\\folder\\file.txt"
        inspected = []

        def attributes(path):
            inspected.append(path)
            return 0x410 if path == junction else 0x10

        self.replace_attribute(compat, "os", Namespace(name="nt", path=ntpath))
        self.replace_attribute(compat, "sys", Namespace(version_info=(2, 7, 18)))
        self.replace_attribute(compat, "_windows_attributes", attributes)
        with self.assertRaises(OSError) as raised:
            compat.assert_resolvable(descendant)
        self.assertEqual(raised.exception.errno, errno.EACCES)
        self.assertEqual(raised.exception.filename, junction)
        self.assertEqual(inspected[0], descendant)
        self.assertIn(junction, inspected)

    def test_directory_junction_removal_never_lists_or_follows_its_target(self):
        junction = "C:\\selected\\junction"
        removed = []

        def forbidden(*args):
            self.fail("Removing a junction must not inspect or unlink its target.")

        fake_os = Namespace(name="nt", path=Namespace(isdir=forbidden),
                            listdir=forbidden, unlink=forbidden, rmdir=removed.append)
        self.replace_attribute(compat, "os", fake_os)
        self.replace_attribute(compat, "_windows_attributes", lambda path: 0x410)
        compat.safe_remove_tree(junction)
        self.assertEqual(removed, [junction])
