"""Port selection regressions for the server factory and real CLI startup."""
from __future__ import absolute_import, unicode_literals

import errno
import json
import os
import socket
import subprocess
import sys
import threading
import time

try:
    import queue
except ImportError:
    import Queue as queue

from tests.support import HTTPConnection, PROJECT_ROOT, TemporaryDirectoryTestCase
from frisbee_core import server as server_module


class StartupTests(TemporaryDirectoryTestCase):
    def replace_factory(self, factory):
        original = server_module.create_server
        self.addCleanup(setattr, server_module, "create_server", original)
        server_module.create_server = factory

    def occupied_port_pair(self):
        """Reserve consecutive real ports and verify the following port is free."""
        for attempt in range(40):
            sockets = []
            try:
                first = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sockets.append(first)
                first.bind(("127.0.0.1", 0))
                port = first.getsockname()[1]
                if port > 65533:
                    continue
                first.listen(1)
                for candidate in (port + 1, port + 2):
                    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    sockets.append(listener)
                    listener.bind(("127.0.0.1", candidate))
                    listener.listen(1)
                sockets.pop().close()
                for listener in sockets:
                    self.addCleanup(listener.close)
                sockets = []
                return port
            except socket.error as error:
                if getattr(error, "errno", None) not in (errno.EADDRINUSE, 10048):
                    raise
            finally:
                for listener in sockets:
                    listener.close()
        self.fail("Could not reserve three consecutive localhost ports.")

    def assert_healthy(self, port):
        connection = HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            connection.request("GET", "/api/health")
            response = connection.getresponse()
            body = response.read()
            self.assertEqual(response.status, 200, body)
            self.assertEqual(json.loads(body.decode("utf-8"))["status"], "ok")
        finally:
            connection.close()

    def serve(self, server):
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever)
        thread.daemon = True
        thread.start()

        def stop():
            server.shutdown()
            thread.join(5)

        self.addCleanup(stop)

    def test_default_start_skips_two_occupied_ports(self):
        attempts = []
        expected = object()

        def factory(host, port, base_dir):
            attempts.append((host, port, base_dir))
            if port in (8080, 8081):
                raise socket.error(errno.EADDRINUSE, "Already occupied")
            return expected

        self.replace_factory(factory)
        actual = server_module.create_available_server(base_dir=self.base_dir)
        self.assertIs(actual, expected)
        self.assertEqual(attempts, [("0.0.0.0", port, self.base_dir) for port in (8080, 8081, 8082)])

    def test_winsock_error_variants_trigger_fallback(self):
        windows_attribute = socket.error("Windows address already in use")
        windows_attribute.winerror = 10048
        legacy_arguments = socket.error(10048, "Legacy address already in use")
        legacy_arguments.errno = None
        errors = [socket.error(10048, "Address already in use"), windows_attribute, legacy_arguments]
        attempts = []
        expected = object()

        def factory(host, port, base_dir):
            attempts.append(port)
            if errors:
                raise errors.pop(0)
            return expected

        self.replace_factory(factory)
        actual = server_module.create_available_server("127.0.0.1", 9000, self.base_dir)
        self.assertIs(actual, expected)
        self.assertEqual(attempts, [9000, 9001, 9002, 9003])

    def test_permission_and_invalid_address_errors_are_not_retried(self):
        for code in (errno.EACCES, errno.EADDRNOTAVAIL):
            attempts = []
            original_error = socket.error(code, "Not a port collision")

            def factory(host, port, base_dir):
                attempts.append(port)
                raise original_error

            self.replace_factory(factory)
            with self.assertRaises(socket.error) as raised:
                server_module.create_available_server("127.0.0.1", 8080, self.base_dir)
            self.assertIs(raised.exception, original_error)
            self.assertEqual(attempts, [8080])

    def test_exhaustion_never_attempts_an_invalid_port(self):
        attempts = []

        def factory(host, port, base_dir):
            attempts.append(port)
            raise socket.error(errno.EADDRINUSE, "Already occupied")

        self.replace_factory(factory)
        with self.assertRaises(socket.error) as raised:
            server_module.create_available_server("127.0.0.1", 65535, self.base_dir)
        self.assertEqual(attempts, [65535])
        self.assertIn("65535", str(raised.exception))

    def test_port_zero_uses_os_assignment_and_strict_factory_still_rejects_collisions(self):
        server = server_module.create_available_server("127.0.0.1", 0, self.base_dir)
        self.addCleanup(server.server_close)
        assigned = server.server_address[1]
        self.assertTrue(0 < assigned <= 65535)
        with self.assertRaises((socket.error, OSError, IOError)):
            server_module.create_server("127.0.0.1", assigned, self.base_dir)

    def test_real_busy_ports_fall_back_to_a_working_http_server(self):
        first = self.occupied_port_pair()
        server = server_module.create_available_server("127.0.0.1", first, self.base_dir)
        self.serve(server)
        self.assertEqual(server.server_address[1], first + 2)
        self.assert_healthy(first + 2)

    def stop_process(self, process, reader):
        if process.poll() is None:
            process.terminate()
            deadline = time.time() + 5
            while process.poll() is None and time.time() < deadline:
                time.sleep(0.02)
            if process.poll() is None:
                process.kill()
        process.wait()
        reader.join(5)
        process.stdout.close()

    def test_cli_announces_and_serves_the_actual_fallback_port(self):
        first = self.occupied_port_pair()
        command = [sys.executable, os.path.join(PROJECT_ROOT, "app.py"),
                   "--host", "127.0.0.1", "--port", str(first),
                   "--data-dir", self.base_dir]
        process = subprocess.Popen(command, cwd=self.base_dir, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, close_fds=(os.name != "nt"))
        lines = queue.Queue()

        def read_output():
            for line in iter(process.stdout.readline, b""):
                lines.put(line.decode("utf-8", "replace").strip())
            lines.put(None)

        reader = threading.Thread(target=read_output)
        reader.daemon = True
        self.addCleanup(self.stop_process, process, reader)
        reader.start()
        captured = []
        deadline = time.time() + 10
        ready = None
        while time.time() < deadline:
            try:
                line = lines.get(timeout=max(0.01, deadline - time.time()))
            except queue.Empty:
                break
            if line is None:
                break
            captured.append(line)
            if line.startswith("Frisbee is ready:"):
                ready = line
                break
        self.assertEqual(ready, "Frisbee is ready: http://localhost:%s/" % (first + 2), captured)
        self.assertIsNone(process.poll())
        self.assert_healthy(first + 2)
