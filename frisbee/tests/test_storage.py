"""Regression coverage for bytes, revisions, archives, and workspace boundaries."""
from __future__ import absolute_import, unicode_literals

import io
import codecs
import os
import zipfile

from tests.support import TemporaryDirectoryTestCase
from frisbee_core.storage import FileStore, NoteStore, StorageError, WorkspaceStore


class StorageTests(TemporaryDirectoryTestCase):
    def setUp(self):
        TemporaryDirectoryTestCase.setUp(self)
        self.workspaces = WorkspaceStore(self.base_dir)
        self.workspace = self.workspaces.create("local")
        self.workspace_id = self.workspace["id"]
        self.files = FileStore(self.workspaces)

    def assert_storage_error(self, callback, status=None):
        with self.assertRaises(StorageError) as raised:
            callback()
        if status is not None:
            self.assertEqual(raised.exception.status, status)

    def test_local_workspace_and_absolute_workspace(self):
        self.assertEqual(os.path.realpath(self.workspace["root"]), os.path.join(self.base_dir, "workspace"))
        directory = os.path.join(self.base_dir, "external")
        os.mkdir(directory)
        absolute = self.workspaces.create("absolute", directory)
        self.assertEqual(os.path.realpath(absolute["root"]), os.path.realpath(directory))
        self.assert_storage_error(lambda: self.workspaces.create("absolute", os.path.join(directory, "missing")))
        self.assert_storage_error(lambda: self.workspaces.create("absolute", self.base_dir + "/workspace/file.txt"))

    def test_workspace_rejects_parent_and_absolute_paths(self):
        self.write_file("outside.txt", b"leave this unchanged")
        for path in ("../outside.txt", "/outside.txt", "nested/../../outside.txt"):
            self.assert_storage_error(lambda: self.workspaces.resolve(self.workspace_id, path))
        self.assertEqual(self.read_file("outside.txt"), b"leave this unchanged")

    def test_workspace_rejects_external_symlink(self):
        if not hasattr(os, "symlink"):
            self.skipTest("Symbolic links are unavailable on this platform.")
        external = self.write_file("outside.txt", b"external")
        try:
            os.symlink(external, os.path.join(self.workspace["root"], "shortcut.txt"))
        except (OSError, NotImplementedError):
            self.skipTest("The current account cannot create symbolic links.")
        self.assert_storage_error(lambda: self.files.content(self.workspace_id, "shortcut.txt"))

    def test_nested_upload_preserves_all_bytes_and_empty_directory(self):
        content = bytes(bytearray(range(256))) * 129
        uploaded = self.files.receive_upload(self.workspace_id, "", "folder/nested/payload.bin", io.BytesIO(content), len(content))
        self.assertEqual(uploaded["path"], "folder/nested/payload.bin")
        self.assertEqual(uploaded["size"], len(content))
        self.assertEqual(self.read_file("workspace/folder/nested/payload.bin"), content)
        self.files.receive_upload(self.workspace_id, "", "folder/empty/", io.BytesIO(b""), 0)
        self.assertTrue(os.path.isdir(os.path.join(self.workspace["root"], "folder", "empty")))

    def test_truncated_upload_does_not_publish_partial_file(self):
        self.assert_storage_error(lambda: self.files.receive_upload(self.workspace_id, "", "incomplete.bin", io.BytesIO(b"partial"), 100))
        self.assertFalse(os.path.exists(os.path.join(self.workspace["root"], "incomplete.bin")))

    def test_upload_rejects_parent_traversal(self):
        self.assert_storage_error(lambda: self.files.receive_upload(self.workspace_id, "", "../escaped.txt", io.BytesIO(b"bad"), 3))
        self.assertFalse(os.path.exists(os.path.join(self.base_dir, "escaped.txt")))

    def test_text_edit_and_stale_revision_conflict(self):
        self.write_file("workspace/note.txt", "Original caf\u00e9\n".encode("utf-8"))
        original = self.files.content(self.workspace_id, "note.txt")
        self.assertEqual(original["content"], "Original caf\u00e9\n")
        edited = self.files.save_content(self.workspace_id, "note.txt", "Edited \u2603\n", original["revision"])
        self.assertNotEqual(edited["revision"], original["revision"])
        self.assertEqual(self.read_file("workspace/note.txt"), "Edited \u2603\n".encode("utf-8"))
        self.assert_storage_error(lambda: self.files.save_content(self.workspace_id, "note.txt", "stale", original["revision"]), 409)
        self.assertEqual(self.files.content(self.workspace_id, "note.txt")["content"], "Edited \u2603\n")

    def test_rename_directory_and_recursive_delete(self):
        self.write_file("workspace/source/deep/file.txt", b"content")
        result = self.files.rename(self.workspace_id, "source", "renamed")
        self.assertEqual(result["path"], "renamed")
        self.assertEqual(self.read_file("workspace/renamed/deep/file.txt"), b"content")
        self.assert_storage_error(lambda: self.files.rename(self.workspace_id, "renamed", "../escaped"))
        deleted = self.files.delete(self.workspace_id, ["renamed"])
        self.assertFalse(deleted["errors"])
        self.assertIn("renamed", deleted["deleted"])
        self.assertFalse(os.path.exists(os.path.join(self.workspace["root"], "renamed")))

    def test_archive_includes_nested_files_unicode_and_empty_directory(self):
        self.write_file("workspace/folder/caf\u00e9.txt", b"coffee")
        self.write_file("workspace/other.bin", b"\x00\xff\x01")
        os.mkdir(os.path.join(self.workspace["root"], "folder", "empty"))
        archive = self.files.build_zip(self.workspace_id, ["folder", "other.bin"])
        try:
            with zipfile.ZipFile(archive, "r") as zipped:
                self.assertEqual(zipped.read("folder/caf\u00e9.txt"), b"coffee")
                self.assertEqual(zipped.read("other.bin"), b"\x00\xff\x01")
                self.assertIn("folder/empty/", zipped.namelist())
                self.assertEqual(zipped.testzip(), None)
        finally:
            archive.close()

    def test_create_directory_and_reject_invalid_names(self):
        directory = self.files.create_directory(self.workspace_id, "", "New folder")
        self.assertEqual(directory["path"], "New folder")
        self.assertTrue(os.path.isdir(os.path.join(self.workspace["root"], "New folder")))
        for name in ("..", "bad/name", ""):
            self.assert_storage_error(lambda: self.files.create_directory(self.workspace_id, "", name))

    def test_listing_metadata_and_preview_kinds(self):
        self.write_file("workspace/folder/first.txt", b"one")
        self.write_file("workspace/folder/second.txt", b"two")
        self.write_file("workspace/folder/nested/third.txt", b"three")
        self.write_file("workspace/plain.md", b"# Heading\n")
        self.write_file("workspace/tool.exe", b"MZ\x00binary")
        self.write_file("workspace/photo.png", b"\x89PNG\r\n\x1a\n")
        listing = self.files.list(self.workspace_id)
        self.assertIsNone(listing["parent"])
        entries = dict((item["name"], item) for item in listing["entries"])
        self.assertEqual(entries["folder"]["kind"], "directory")
        self.assertEqual(entries["folder"]["file_count"], 2)
        self.assertEqual(entries["plain.md"]["size"], 10)
        self.assertEqual(entries["plain.md"]["preview"], "text")
        self.assertEqual(entries["tool.exe"]["preview"], "binary")
        self.assertEqual(entries["photo.png"]["preview"], "image")
        # Creation time is optional; Unix metadata-change time is not a birth time.
        info = os.stat(os.path.join(self.workspace["root"], "plain.md"))
        if os.name != "nt" and not hasattr(info, "st_birthtime"):
            self.assertIsNone(entries["plain.md"]["created"])
        else:
            self.assertTrue(entries["plain.md"]["created"] > 0)
        self.assertEqual(self.files.list(self.workspace_id, "folder/nested")["parent"], "folder")

    def test_listing_recognizes_videos_without_changing_other_preview_kinds(self):
        fixtures = (("clip.MP4", b"\x00\x00\x00\x18ftypmp42", "video"),
                    ("clip.m4v", b"\x00\x00\x00\x18ftypmp42", "video"),
                    ("clip.WeBm", b"\x1a\x45\xdf\xa3\x00", "video"),
                    ("clip.ogv", b"OggS\x00", "video"),
                    ("photo.PNG", b"\x89PNG\r\n\x1a\n", "image"),
                    ("readme.md", b"# Readme\n", "text"),
                    ("component.ts", b"const answer: number = 42;\n", "text"),
                    ("installer.EXE", b"MZ\x00binary", "binary"),
                    ("unknown.data", b"\x00\xffbinary", "binary"))
        for filename, content, expected in fixtures:
            self.write_file("workspace/" + filename, content)
        entries = dict((item["name"], item) for item in self.files.list(self.workspace_id)["entries"])
        for filename, content, expected in fixtures:
            self.assertEqual(entries[filename]["preview"], expected, filename)
            self.assertEqual(entries[filename]["kind"], "file", filename)
            self.assertEqual(entries[filename]["size"], len(content), filename)

    def test_text_edit_preserves_unicode_byte_order_mark(self):
        original = "Original \u2603".encode("utf-16")
        self.write_file("workspace/unicode.txt", original)
        opened = self.files.content(self.workspace_id, "unicode.txt")
        self.files.save_content(self.workspace_id, "unicode.txt", "Edited \u00e9", opened["revision"])
        actual = self.read_file("workspace/unicode.txt")
        self.assertTrue(actual.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)))
        self.assertEqual(actual.decode("utf-16"), "Edited \u00e9")

    def test_text_edit_preserves_explicit_big_endian_encoding(self):
        original_text = "Original \u2603"
        edited_text = "Edited caf\u00e9"
        for encoding, marker in (("utf-16-be", codecs.BOM_UTF16_BE), ("utf-32-be", codecs.BOM_UTF32_BE)):
            filename = encoding + ".txt"
            self.write_file("workspace/" + filename, marker + original_text.encode(encoding))
            opened = self.files.content(self.workspace_id, filename)
            self.assertEqual(opened["content"], original_text)
            self.files.save_content(self.workspace_id, filename, edited_text, opened["revision"])
            self.assertEqual(self.read_file("workspace/" + filename), marker + edited_text.encode(encoding))

    def test_binary_bytes_cannot_be_overwritten_by_text_editor(self):
        original = b"binary\x00\xffcontent"
        self.write_file("workspace/program.exe", original)
        self.assert_storage_error(lambda: self.files.content(self.workspace_id, "program.exe"), 415)
        self.assert_storage_error(lambda: self.files.save_content(self.workspace_id, "program.exe", "replacement"), 415)
        self.assertEqual(self.read_file("workspace/program.exe"), original)

    def test_overlapping_delete_selection_removes_a_directory_once(self):
        self.write_file("workspace/folder/file.txt", b"content")
        result = self.files.delete(self.workspace_id, ["folder", "folder/file.txt"])
        self.assertEqual(result["deleted"], ["folder"])
        self.assertEqual(result["errors"], [])

    def test_root_cannot_be_deleted_or_renamed(self):
        self.assert_storage_error(lambda: self.files.delete(self.workspace_id, [""]), 403)
        self.assert_storage_error(lambda: self.files.rename(self.workspace_id, "", "replacement"), 403)
        self.assertTrue(os.path.isdir(self.workspace["root"]))


class NoteTests(TemporaryDirectoryTestCase):
    def setUp(self):
        TemporaryDirectoryTestCase.setUp(self)
        self.notes = NoteStore(self.base_dir)

    def test_notes_are_available_without_workspace(self):
        self.assertEqual(self.notes.list()["notes"], [])
        note = self.notes.save("Shopping", "Milk\nBread\n", create=True)
        self.assertEqual(note["name"], "Shopping")
        self.assertEqual(self.read_file("notepad/Shopping.txt"), b"Milk\nBread\n")
        self.assertEqual(self.notes.get("Shopping")["content"], "Milk\nBread\n")
        self.assertIn("Shopping", [item["name"] for item in self.notes.list()["notes"]])
        self.notes.delete("Shopping")
        self.assertEqual(self.notes.list()["notes"], [])

    def test_note_revisions_prevent_lost_updates(self):
        note = self.notes.save("Plan", "first", create=True)
        saved = self.notes.save("Plan", "second", note["revision"])
        self.assertNotEqual(saved["revision"], note["revision"])
        with self.assertRaises(StorageError) as raised:
            self.notes.save("Plan", "stale", note["revision"])
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(self.notes.get("Plan")["content"], "second")

    def test_note_names_cannot_escape_the_notepad_directory(self):
        for name in ("../outside", "/outside", "nested/note", ""):
            with self.assertRaises(StorageError):
                self.notes.save(name, "invalid", create=True)
        self.assertFalse(os.path.exists(os.path.join(self.base_dir, "outside.txt")))

    def test_duplicate_note_creation_preserves_existing_content(self):
        self.notes.save("Keep", "original", create=True)
        with self.assertRaises(StorageError) as raised:
            self.notes.save("Keep", "replacement", create=True)
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(self.notes.get("Keep")["content"], "original")
