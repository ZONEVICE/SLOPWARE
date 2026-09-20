"""Real HTTP tests covering the public API without third-party clients."""
from __future__ import absolute_import, unicode_literals

import io
import json
import os
import threading
import time
import zipfile

from tests.support import HTTPTestCase


class ApplicationHTTPTests(HTTPTestCase):
    def create_workspace(self):
        response = self.json_request("POST", "/api/workspaces", {"mode": "local"}, expected_status=None)
        self.workspace = response["workspace"]
        return self.workspace["id"]

    def wait_for_job(self, job_id):
        deadline = time.time() + 10
        while time.time() < deadline:
            job = self.json_request("GET", "/api/jobs/" + job_id)["job"]
            if job["status"] not in ("pending", "queued", "running"):
                return job
            time.sleep(0.02)
        self.fail("The background operation did not finish within ten seconds.")

    def test_static_application_and_unknown_routes(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["content-type"])
        self.assertIn(b"Notepad", body)
        status, headers, body = self.request("GET", "/api/not-a-route")
        self.assertEqual(status, 404)

    def test_notepad_crud_before_workspace_selection(self):
        self.assertEqual(self.json_request("GET", "/api/notes")["notes"], [])
        created = self.json_request("POST", "/api/notes", {"name": "Travel", "content": "Pack a charger"}, expected_status=None)
        path = self.query("/api/notes", name="Travel")
        original = self.json_request("GET", path)
        self.assertEqual(original["content"], "Pack a charger")
        updated = self.json_request("PUT", "/api/notes", {"name": "Travel", "content": "Bring caf\u00e9", "revision": original["revision"]})
        self.assertNotEqual(updated["revision"], original["revision"])
        self.json_request("PUT", "/api/notes", {"name": "Travel", "content": "stale", "revision": original["revision"]}, expected_status=409)
        self.assertEqual(self.read_file("notepad/Travel.txt"), "Bring caf\u00e9".encode("utf-8"))
        self.json_request("DELETE", path)
        self.assertEqual(self.json_request("GET", "/api/notes")["notes"], [])

    def test_upload_list_edit_rename_download_and_delete(self):
        workspace = self.create_workspace()
        content = "First caf\u00e9\n".encode("utf-8")
        upload_url = self.query("/api/upload", workspace=workspace, path="", name="folder/readme.txt")
        status, headers, body = self.request("POST", upload_url, raw=content)
        self.assertTrue(200 <= status < 300, body)
        listing = self.json_request("GET", self.query("/api/files", workspace=workspace, path="folder"))
        self.assertEqual([item["name"] for item in listing["entries"]], ["readme.txt"])
        self.assertEqual(listing["entries"][0]["size"], len(content))
        original = self.json_request("GET", self.query("/api/content", workspace=workspace, path="folder/readme.txt"))
        saved = self.json_request("PUT", "/api/content", {"workspace": workspace, "path": "folder/readme.txt", "content": "Edited", "revision": original["revision"]})
        self.assertEqual(saved["content"], "Edited")
        self.json_request("POST", "/api/rename", {"workspace": workspace, "path": "folder/readme.txt", "name": "renamed.txt"})
        status, headers, body = self.request("GET", self.query("/api/download", workspace=workspace, path="folder/renamed.txt"))
        self.assertEqual(status, 200)
        self.assertEqual(body, b"Edited")
        self.assertIn("attachment", headers.get("content-disposition", ""))
        self.json_request("POST", "/api/delete", {"workspace": workspace, "paths": ["folder"]})
        self.assertFalse(os.path.exists(os.path.join(self.workspace["root"], "folder")))

    def test_binary_upload_download_range_and_unicode_filename(self):
        workspace = self.create_workspace()
        content = bytes(bytearray(range(256))) * 257
        filename = "caf\u00e9 data.bin"
        status, headers, body = self.request("POST", self.query("/api/upload", workspace=workspace, path="", name=filename), raw=content)
        self.assertTrue(200 <= status < 300, body)
        download = self.query("/api/download", workspace=workspace, path=filename)
        status, headers, body = self.request("GET", download)
        self.assertEqual(status, 200)
        self.assertEqual(body, content)
        self.assertIn("filename*=UTF-8''", headers.get("content-disposition", ""))
        status, headers, body = self.request("GET", download, headers={"Range": "bytes=2-5"})
        self.assertEqual(status, 206)
        self.assertEqual(body, content[2:6])
        self.assertEqual(headers["content-range"], "bytes 2-5/%s" % len(content))
        status, headers, body = self.request("GET", download, headers={"Range": "bytes=999999-"})
        self.assertEqual(status, 416)

    def test_media_preview_uses_deterministic_types_without_attachment(self):
        workspace = self.create_workspace()
        fixtures = (("clip.MP4", "video/mp4", b"\x00\x00\x00\x18ftypmp42"),
                    ("clip.M4V", "video/mp4", b"\x00\x00\x00\x18ftypmp42"),
                    ("clip.webm", "video/webm", b"\x1a\x45\xdf\xa3\x00"),
                    ("clip.ogv", "video/ogg", b"OggS\x00"),
                    ("photo.PNG", "image/png", b"\x89PNG\r\n\x1a\n"))
        for filename, expected_type, content in fixtures:
            self.write_file("workspace/" + filename, content)
            status, headers, body = self.request("GET", self.query("/api/preview", workspace=workspace, path=filename))
            self.assertEqual(status, 200, filename)
            self.assertEqual(headers["content-type"], expected_type, filename)
            self.assertEqual(body, content, filename)
            self.assertNotIn("content-disposition", headers, filename)
            self.assertEqual(headers["accept-ranges"], "bytes", filename)
            self.assertEqual(headers["x-content-type-options"], "nosniff", filename)

    def test_video_preview_supports_seeking_ranges_and_head(self):
        workspace = self.create_workspace()
        # Byte transport is tested here; codec playback uses a real browser fixture.
        content = b"\x00\x00\x00\x18ftypmp42" + bytes(bytearray(range(256))) * 257
        self.write_file("workspace/seekable.mp4", content)
        preview = self.query("/api/preview", workspace=workspace, path="seekable.mp4")
        status, headers, body = self.request("GET", preview, headers={"Range": "bytes=1024-2047"})
        self.assertEqual(status, 206)
        self.assertEqual(headers["content-type"], "video/mp4")
        self.assertEqual(headers["content-range"], "bytes 1024-2047/%s" % len(content))
        self.assertEqual(headers["content-length"], "1024")
        self.assertEqual(body, content[1024:2048])
        self.assertNotIn("content-disposition", headers)
        status, headers, body = self.request("HEAD", preview)
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "video/mp4")
        self.assertEqual(headers["content-length"], str(len(content)))
        self.assertEqual(body, b"")
        self.assertNotIn("content-disposition", headers)
        status, headers, body = self.request("HEAD", preview, headers={"Range": "bytes=1024-2047"})
        self.assertEqual(status, 206)
        self.assertEqual(headers["content-range"], "bytes 1024-2047/%s" % len(content))
        self.assertEqual(headers["content-length"], "1024")
        self.assertEqual(body, b"")

    def test_media_preview_rejects_text_and_executable_files(self):
        workspace = self.create_workspace()
        for filename, content in (("notes.txt", b"plain text"),
                                  ("component.ts", b"const answer: number = 42;\n"),
                                  ("installer.exe", b"MZ\x00binary")):
            self.write_file("workspace/" + filename, content)
            result = self.json_request("GET", self.query("/api/preview", workspace=workspace, path=filename), expected_status=415)
            self.assertIn("error", result)
            self.assertEqual(self.read_file("workspace/" + filename), content)

    def test_video_preview_rejects_parent_traversal(self):
        workspace = self.create_workspace()
        content = b"\x00\x00\x00\x18ftypmp42outside"
        self.write_file("outside.mp4", content)
        result = self.json_request("GET", self.query("/api/preview", workspace=workspace, path="../outside.mp4"), expected_status=403)
        self.assertIn("error", result)
        self.assertEqual(self.read_file("outside.mp4"), content)

    def test_archive_download_preserves_selection_and_empty_directories(self):
        workspace = self.create_workspace()
        self.write_file("workspace/bundle/file.txt", b"nested content")
        os.mkdir(os.path.join(self.workspace["root"], "bundle", "empty"))
        self.write_file("workspace/unselected.txt", b"not selected")
        response = self.json_request("POST", "/api/archives", {"workspace": workspace, "paths": ["bundle"]}, expected_status=None)
        status, headers, body = self.request("GET", response["download_url"])
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers.get("content-disposition", ""))
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            self.assertEqual(archive.read("bundle/file.txt"), b"nested content")
            self.assertIn("bundle/empty/", archive.namelist())
            self.assertNotIn("unselected.txt", archive.namelist())

    def test_move_job_completes_and_reports_progress(self):
        workspace = self.create_workspace()
        self.write_file("workspace/one.txt", b"one")
        self.write_file("workspace/two/deep.txt", b"two")
        os.mkdir(os.path.join(self.workspace["root"], "target"))
        response = self.json_request("POST", "/api/move", {"workspace": workspace, "paths": ["one.txt", "two"], "destination": "target"}, expected_status=None)
        job = self.wait_for_job(response["job"]["id"])
        self.assertFalse(job["errors"])
        self.assertEqual(job["completed"], job["total"])
        self.assertEqual(job["bytes_done"], job["bytes_total"])
        self.assertEqual(self.read_file("workspace/target/one.txt"), b"one")
        self.assertEqual(self.read_file("workspace/target/two/deep.txt"), b"two")
        self.assertFalse(os.path.exists(os.path.join(self.workspace["root"], "one.txt")))
        self.assertFalse(os.path.exists(os.path.join(self.workspace["root"], "two")))

    def test_malformed_json_and_path_traversal_are_rejected(self):
        workspace = self.create_workspace()
        status, headers, body = self.request("POST", "/api/workspaces", raw=b"{not json", headers={"Content-Type": "application/json"})
        self.assertEqual(status, 400)
        self.write_file("outside.txt", b"outside")
        status, headers, body = self.request("GET", self.query("/api/download", workspace=workspace, path="../outside.txt"))
        self.assertTrue(400 <= status < 500)
        self.assertNotEqual(body, b"outside")
        status, headers, body = self.request("POST", self.query("/api/upload", workspace=workspace, path="", name="../changed.txt"), raw=b"invalid")
        self.assertTrue(400 <= status < 500)
        self.assertFalse(os.path.exists(os.path.join(self.base_dir, "changed.txt")))

    def test_parallel_clients_can_read_notes_and_files(self):
        workspace = self.create_workspace()
        self.write_file("workspace/example.txt", b"example")
        self.json_request("POST", "/api/notes", {"name": "Shared", "content": "Read from several devices"}, expected_status=None)
        errors = []

        def read_resources(index):
            try:
                if index % 2:
                    value = self.json_request("GET", self.query("/api/notes", name="Shared"))
                    self.assertEqual(value["content"], "Read from several devices")
                else:
                    value = self.json_request("GET", self.query("/api/files", workspace=workspace, path=""))
                    self.assertEqual(value["entries"][0]["name"], "example.txt")
            except Exception as error:
                errors.append(error)

        threads = [threading.Thread(target=read_resources, args=(index,)) for index in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])

    def test_unrelated_browser_origins_cannot_change_notes(self):
        payload = {"name": "Protected", "content": "same-origin content"}
        for origin in ("http://unrelated.example", "null"):
            self.json_request("POST", "/api/notes", payload, expected_status=403, headers={"Origin": origin})
        self.assertEqual(self.json_request("GET", "/api/notes")["notes"], [])
        origin = "http://127.0.0.1:%s" % self.server.server_address[1]
        self.json_request("POST", "/api/notes", payload, expected_status=None, headers={"Origin": origin})
        self.assertEqual(self.json_request("GET", self.query("/api/notes", name="Protected"))["content"], payload["content"])

    def test_two_workspace_roots_remain_independently_addressable(self):
        first_id = self.create_workspace()
        self.write_file("workspace/shared.txt", b"local root")
        self.write_file("external/shared.txt", b"absolute root")
        other = self.json_request("POST", "/api/workspaces", {"mode": "absolute", "path": os.path.join(self.base_dir, "external")}, expected_status=None)["workspace"]
        self.assertNotEqual(first_id, other["id"])
        for workspace, expected in ((first_id, "local root"), (other["id"], "absolute root"), (first_id, "local root")):
            content = self.json_request("GET", self.query("/api/content", workspace=workspace, path="shared.txt"))
            self.assertEqual(content["content"], expected)
        self.json_request("PUT", "/api/content", {"workspace": other["id"], "path": "shared.txt", "content": "changed external"})
        self.assertEqual(self.read_file("workspace/shared.txt"), b"local root")
        self.assertEqual(self.read_file("external/shared.txt"), b"changed external")

    def test_range_suffix_and_empty_or_reversed_ranges(self):
        workspace = self.create_workspace()
        self.write_file("workspace/digits.txt", b"01234567")
        download = self.query("/api/download", workspace=workspace, path="digits.txt")
        status, headers, body = self.request("GET", download, headers={"Range": "bytes=-3"})
        self.assertEqual(status, 206)
        self.assertEqual(body, b"567")
        self.assertEqual(headers["content-range"], "bytes 5-7/8")
        for value in ("bytes=8-", "bytes=5-2", "bytes=-0"):
            status, headers, body = self.request("GET", download, headers={"Range": value})
            self.assertEqual(status, 416)
            self.assertEqual(headers["content-range"], "bytes */8")
            self.assertEqual(body, b"")

    def test_head_has_download_metadata_and_no_response_body(self):
        workspace = self.create_workspace()
        self.write_file("workspace/head.txt", b"abcdefgh")
        download = self.query("/api/download", workspace=workspace, path="head.txt")
        status, headers, body = self.request("HEAD", download)
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-length"], "8")
        self.assertEqual(body, b"")
        status, headers, body = self.request("HEAD", download, headers={"Range": "bytes=1-3"})
        self.assertEqual(status, 206)
        self.assertEqual(headers["content-length"], "3")
        self.assertEqual(headers["content-range"], "bytes 1-3/8")
        self.assertEqual(body, b"")

    def test_host_root_workspace_can_be_listed_when_readable(self):
        status, headers, body = self.request("POST", "/api/workspaces", {"mode": "host"})
        if status in (403, 404):
            self.skipTest("The current account cannot list the host root.")
        self.assertTrue(200 <= status < 300, body)
        workspace = json.loads(body.decode("utf-8"))["workspace"]
        self.assertEqual(workspace["mode"], "host")
        expected_root = os.environ.get("SystemDrive", "C:") + os.sep if os.name == "nt" else os.sep
        self.assertEqual(os.path.normcase(workspace["root"]), os.path.normcase(os.path.realpath(expected_root)))
        listing = self.json_request("GET", self.query("/api/files", workspace=workspace["id"], path=""))
        self.assertIsInstance(listing["entries"], list)
        self.assertIsNone(listing["parent"])
