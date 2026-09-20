"""Small test helpers shared by storage and real-HTTP regression tests."""
from __future__ import absolute_import, unicode_literals

import io
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest

try:
    from http.client import HTTPConnection
    from urllib.parse import urlencode
except ImportError:
    from httplib import HTTPConnection
    from urllib import urlencode


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)


class TemporaryDirectoryTestCase(unittest.TestCase):
    """Keep every filesystem operation inside a disposable test directory."""

    def setUp(self):
        self.base_dir = tempfile.mkdtemp(prefix="frisbee-test-")
        self.addCleanup(shutil.rmtree, self.base_dir, True)

    def write_file(self, relative_path, content=b"example"):
        path = os.path.join(self.base_dir, relative_path)
        parent = os.path.dirname(path)
        if not os.path.isdir(parent):
            os.makedirs(parent)
        with io.open(path, "wb") as handle:
            handle.write(content)
        return path

    def read_file(self, relative_path):
        with io.open(os.path.join(self.base_dir, relative_path), "rb") as handle:
            return handle.read()


class HTTPTestCase(TemporaryDirectoryTestCase):
    """Exercise actual request framing with an ephemeral loopback server."""

    def setUp(self):
        TemporaryDirectoryTestCase.setUp(self)
        from frisbee_core.server import create_server
        self.server = create_server("127.0.0.1", 0, self.base_dir)
        self.server_thread = threading.Thread(target=self.server.serve_forever)
        self.server_thread.daemon = True
        self.server_thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(5)

    def request(self, method, path, data=None, headers=None, raw=None):
        """Return status, lowercase response headers, and the untouched body."""
        request_headers = dict(headers or {})
        body = raw
        if data is not None:
            body = json.dumps(data, ensure_ascii=True).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
        if body is not None:
            request_headers.setdefault("Content-Length", str(len(body)))
        connection = HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=10)
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            return response.status, dict((key.lower(), value) for key, value in response.getheaders()), response.read()
        finally:
            connection.close()

    def json_request(self, method, path, data=None, expected_status=200, headers=None):
        status, response_headers, body = self.request(method, path, data, headers)
        if expected_status is None:
            self.assertTrue(200 <= status < 300, "%s: %r" % (status, body))
        else:
            self.assertEqual(status, expected_status, body)
        self.assertIn("application/json", response_headers.get("content-type", ""))
        return json.loads(body.decode("utf-8"))

    def query(self, endpoint, **values):
        # Python 2's urlencode needs byte strings for non-ASCII values.
        encoded = []
        for key, value in values.items():
            if isinstance(value, type(u"")):
                value = value.encode("utf-8")
            encoded.append((key, value))
        return endpoint + "?" + urlencode(encoded)
