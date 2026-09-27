"""Starting up: the free-port walk, and the real command line in a subprocess."""
import errno
import json
import os
import queue
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

from tests.support import PROJECT_ROOT
from tests.support.server import RunningLurker
from server.lib.listen import PortsExhausted, bind_first_free


def reserve_run(length=3, attempts=50):
    """A port P such that P..P+length-1 are all free right now."""
    for _ in range(attempts):
        probe = socket.socket()
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
        probe.close()
        if port + length > 65535:
            continue
        sockets = []
        try:
            for offset in range(length):
                s = socket.socket()
                s.bind(('127.0.0.1', port + offset))
                sockets.append(s)
            return port
        except OSError:
            continue
        finally:
            for s in sockets:
                s.close()
    raise RuntimeError('no free port run')


def occupy(port):
    listener = socket.socket()
    listener.bind(('127.0.0.1', port))
    listener.listen(1)
    return listener


class BindFirstFreeTests(unittest.TestCase):
    def test_port_zero_is_passed_through(self):
        calls = []
        self.assertEqual(bind_first_free(lambda port: calls.append(port) or 'server', 0), 'server')
        self.assertEqual(calls, [0])

    def test_walks_upwards_on_address_in_use_only(self):
        calls = []

        def create(port):
            calls.append(port)
            if port < 8083:
                raise OSError(errno.EADDRINUSE, 'in use')
            return port

        busy = []
        self.assertEqual(bind_first_free(create, 8080, on_busy=busy.append), 8083)
        self.assertEqual(calls, [8080, 8081, 8082, 8083])
        self.assertEqual(busy, [8080, 8081, 8082])

    def test_other_errors_are_raised_at_once(self):
        calls = []

        def create(port):
            calls.append(port)
            raise PermissionError(errno.EACCES, 'denied')

        with self.assertRaises(PermissionError):
            bind_first_free(create, 80)
        self.assertEqual(calls, [80])

    def test_walk_is_bounded_and_says_which_range(self):
        def create(port):
            raise OSError(errno.EADDRINUSE, 'in use')

        with self.assertRaises(PortsExhausted) as caught:
            bind_first_free(create, 9000, attempts=64)
        self.assertEqual((caught.exception.first, caught.exception.last), (9000, 9063))
        self.assertIn('9000', str(caught.exception))
        self.assertIn('9063', str(caught.exception))

    def test_walk_stops_at_65535(self):
        seen = []

        def create(port):
            seen.append(port)
            raise OSError(errno.EADDRINUSE, 'in use')

        with self.assertRaises(PortsExhausted):
            bind_first_free(create, 65530, attempts=64)
        self.assertEqual(seen[-1], 65535)


class RealServerPortTests(unittest.TestCase):
    def test_busy_port_moves_to_the_next_one(self):
        port = reserve_run(3)
        first = occupy(port)
        second = occupy(port + 1)
        self.addCleanup(first.close)
        self.addCleanup(second.close)
        from server.app import LurkerApp
        from server.config import Config
        cert_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, cert_dir, True)
        app = LurkerApp(Config(protocol='http', port=port, host='127.0.0.1', cert_dir=cert_dir)).start()
        self.addCleanup(app.close)
        self.assertEqual(app.port, port + 2)
        self.assertEqual(app.busy_ports, [port, port + 1])
        self.assertEqual(app.identity.as_dict()['port'], port + 2)


class CommandLineTests(unittest.TestCase):
    """Run `python3 lurker.py ...` exactly as a user would."""

    def launch(self, *args):
        process = subprocess.Popen(
            [sys.executable, '-u', os.path.join(PROJECT_ROOT, 'lurker.py')] + list(args),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=tempfile.gettempdir())
        lines = queue.Queue()

        def pump():
            for line in process.stdout:
                lines.put(line)

        threading.Thread(target=pump, daemon=True).start()

        def stop():
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(10)
                except subprocess.TimeoutExpired:
                    process.kill()
            process.stdout.close()

        self.addCleanup(stop)
        output = []
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                line = lines.get(timeout=0.5)
            except queue.Empty:
                if process.poll() is not None:
                    break
                continue
            output.append(line)
            if line.startswith('Press Ctrl+C'):
                break
        return process, ''.join(output)

    def state(self, port):
        with urllib.request.urlopen('http://127.0.0.1:%d/api/state' % port, timeout=10) as response:
            return json.loads(response.read().decode())

    def test_running_twice_gives_two_servers(self):
        port = reserve_run(3)
        _, first = self.launch('http', 'port', str(port), 'host', '127.0.0.1')
        self.assertIn('http://127.0.0.1:%d' % port, first)
        _, second = self.launch('http', 'port', str(port), 'host', '127.0.0.1')
        self.assertIn('Port %d was busy, so it is using port %d.' % (port, port + 1), second)
        self.assertIn('http://127.0.0.1:%d' % (port + 1), second)
        self.assertEqual(self.state(port)['app']['port'], port)
        self.assertEqual(self.state(port + 1)['app']['port'], port + 1)

    def test_dir_opens_the_album_at_startup(self):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        port = reserve_run(1)
        _, output = self.launch('http', 'port', str(port), 'host', '127.0.0.1', 'dir', directory)
        self.assertIn('Album           %s' % directory, output)
        album = self.state(port)['album']
        self.assertIn(album['status'], ('scanning', 'ready'))
        self.assertEqual(album['root'], directory)

    def test_unusable_dir_falls_back_to_the_form(self):
        port = reserve_run(1)
        _, output = self.launch('--http', '--port', str(port), '--host', '127.0.0.1', '--dir', '/definitely/not/here')
        self.assertIn('is not usable', output)
        album = self.state(port)['album']
        self.assertEqual(album['status'], 'empty')
        self.assertEqual(album['notice']['code'], 'not_found')

    def test_password_is_mentioned_but_never_printed(self):
        port = reserve_run(1)
        _, output = self.launch('http', 'port', str(port), 'host', '127.0.0.1', 'pass', 'hunter2-secret')
        self.assertIn('required from every browser', output)
        self.assertNotIn('hunter2-secret', output)

    def test_help_and_bad_options(self):
        done = subprocess.run([sys.executable, os.path.join(PROJECT_ROOT, 'lurker.py'), 'help'],
                              capture_output=True, text=True, timeout=20)
        self.assertEqual(done.returncode, 0)
        self.assertIn('port <number>', done.stdout)
        bad = subprocess.run([sys.executable, os.path.join(PROJECT_ROOT, 'lurker.py'), 'port'],
                             capture_output=True, text=True, timeout=20)
        self.assertEqual(bad.returncode, 2)
        self.assertIn('needs a value', bad.stderr)

    def test_stops_cleanly_on_sigterm(self):
        port = reserve_run(1)
        process, _ = self.launch('http', 'port', str(port), 'host', '127.0.0.1')
        process.terminate()
        self.assertEqual(process.wait(10), 0)


class BackgroundServerTests(unittest.TestCase):
    def test_helper_server_answers(self):
        server = RunningLurker()
        self.addCleanup(server.close)
        reply = server.get('/api/state')
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.json()['app']['name'], 'Lurker')


if __name__ == '__main__':
    unittest.main()
