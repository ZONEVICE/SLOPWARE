"""The live event stream every browser listens to."""
import http.client
import json
import os
import threading
import time
import unittest

from tests.support import fixtures as fx
from tests.support.server import AlbumTestCase


class EventReader:
    """Reads `event: state` messages from /api/events in a background thread."""

    def __init__(self, server, cookie=None):
        self.connection = http.client.HTTPConnection('127.0.0.1', server.port, timeout=30)
        headers = {'Accept': 'text/event-stream', 'User-Agent': 'lurker-tests'}
        if cookie:
            headers['Cookie'] = cookie
        self.connection.request('GET', '/api/events', headers=headers)
        self.response = self.connection.getresponse()
        self.states = []
        self.ended = threading.Event()
        self.lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        event = None
        try:
            while True:
                line = self.response.fp.readline()
                if not line:
                    break
                line = line.decode('utf-8').rstrip('\n')
                if line.startswith('event:'):
                    event = line[6:].strip()
                elif line.startswith('data:') and event == 'state':
                    with self.lock:
                        self.states.append(json.loads(line[5:]))
        except (OSError, ValueError):
            pass
        finally:
            self.ended.set()

    def wait(self, predicate, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                for state in self.states:
                    if predicate(state):
                        return state
            time.sleep(0.02)
        raise AssertionError('no matching event; got %r' % self.states[-3:])

    def close(self):
        self.connection.close()


class EventStreamTests(AlbumTestCase):
    def test_initial_state_then_changes(self):
        server = self.start()
        reader = EventReader(server)
        self.addCleanup(reader.close)
        self.assertEqual(reader.response.status, 200)
        self.assertTrue(reader.response.getheader('Content-Type').startswith('text/event-stream'))
        self.assertEqual(reader.response.getheader('Cache-Control'), 'no-store')
        reader.wait(lambda state: state['status'] == 'empty')
        fx.write(self.path('a.png'), fx.png(4, 4))
        server.post('/api/album/open', {'path': self.root})
        ready = reader.wait(lambda state: state['status'] == 'ready' and state['counts']['probed'] == 1)
        self.assertEqual(ready['root'], os.path.normpath(self.root))
        server.post('/api/album/close')
        reader.wait(lambda state: state['status'] == 'empty' and state['recent'])

    def test_many_changes_are_folded_into_few_events(self):
        for index in range(600):
            fx.write(self.path('d%02d' % (index // 25), 'f%03d.png' % index), fx.png(2, 2))
        server = self.start()
        reader = EventReader(server)
        self.addCleanup(reader.close)
        reader.wait(lambda state: state['status'] == 'empty')
        started = time.time()
        server.post('/api/album/open', {'path': self.root})
        reader.wait(lambda state: state['status'] == 'ready' and state['counts']['probed'] == 600, timeout=30)
        elapsed = time.time() - started
        # At most one event per 0.2 s (plus the initial one and the final change).
        self.assertLessEqual(len(reader.states), elapsed / 0.2 + 3)

    def test_every_browser_hears_about_a_close(self):
        fx.write(self.path('a.png'), fx.png(4, 4))
        server = self.start(directory=self.root)
        readers = [EventReader(server) for _ in range(3)]
        for reader in readers:
            self.addCleanup(reader.close)
            reader.wait(lambda state: state['status'] in ('scanning', 'ready'))
        server.post('/api/album/close')
        for reader in readers:
            reader.wait(lambda state: state['status'] == 'empty')

    def test_logging_out_ends_that_browsers_stream(self):
        server = self.start(password='pw')
        cookie = server.login('pw')
        reader = EventReader(server, cookie=cookie)
        self.addCleanup(reader.close)
        reader.wait(lambda state: state['status'] == 'empty')
        server.post('/api/auth/logout', cookie=cookie)
        self.assertTrue(reader.ended.wait(5))

    def test_streams_end_when_lurker_stops(self):
        server = self.start()
        reader = EventReader(server)
        self.addCleanup(reader.close)
        reader.wait(lambda state: state['status'] == 'empty')
        server.app.close()
        self.assertTrue(reader.ended.wait(5))


if __name__ == '__main__':
    unittest.main()
