"""Start a real Lurker on an ephemeral port and talk HTTP to it."""
import http.client
import json
import os
import shutil
import ssl
import tempfile
import time
import unittest

from . import PROJECT_ROOT  # noqa: F401  (puts the project on sys.path)
from server.app import LurkerApp
from server.config import Config


class Reply:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers
        self.body = body

    def json(self):
        return json.loads(self.body.decode('utf-8'))

    def header(self, name):
        return self.headers.get(name.lower())

    def __repr__(self):
        return '<Reply %d %r>' % (self.status, self.body[:200])


class RunningLurker:
    def __init__(self, directory=None, password=None, protocol='http', host='127.0.0.1', workers=2):
        self.cert_dir = tempfile.mkdtemp(prefix='lurker-cert-')
        config = Config(protocol=protocol, port=0, host=host, directory=directory, password=password,
                        cert_dir=self.cert_dir, probe_workers=workers)
        self.app = LurkerApp(config)
        self.app.album.commit_interval = 0.05  # publish revisions faster than a person needs
        self.app.start().start_in_background()
        self.port = self.app.port
        self.protocol = protocol

    @property
    def base(self):
        return '%s://127.0.0.1:%d' % (self.protocol, self.port)

    def connection(self, timeout=10):
        if self.protocol == 'https':
            context = ssl.create_default_context(cafile=self.app.certificate.cert_path)
            return http.client.HTTPSConnection('127.0.0.1', self.port, timeout=timeout, context=context)
        return http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)

    def request(self, method, path, body=None, json_body=None, headers=None, cookie=None, timeout=10):
        headers = dict(headers or {})
        headers.setdefault('User-Agent', 'lurker-tests')
        if json_body is not None:
            body = json.dumps(json_body).encode('utf-8')
            headers.setdefault('Content-Type', 'application/json')
        if cookie:
            headers['Cookie'] = cookie
        connection = self.connection(timeout)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read()
            return Reply(response.status, {key.lower(): value for key, value in response.getheaders()}, data)
        finally:
            connection.close()

    def get(self, path, **kwargs):
        return self.request('GET', path, **kwargs)

    def post(self, path, json_body=None, **kwargs):
        return self.request('POST', path, json_body={} if json_body is None else json_body, **kwargs)

    def login(self, password, user_agent='lurker-tests'):
        """Unlock with the form; returns the Cookie header value."""
        body = ('password=%s' % password).encode()
        reply = self.request('POST', '/login', body=body,
                             headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': user_agent})
        if reply.status != 303:
            raise AssertionError('login failed: %r' % reply)
        return reply.header('set-cookie').split(';', 1)[0]

    def wait_ready(self, timeout=20):
        """Wait until the album is scanned and every header has been read."""
        deadline = time.time() + timeout
        status = None
        while time.time() < deadline:
            status = self.app.album.status()
            if status['status'] == 'ready' and status['probe']['done'] >= status['probe']['total'] \
                    and not self.app.album.session.catalog.dirty:
                self.app.album.session.catalog.commit()
                return self.app.album.status()
            time.sleep(0.05)
        raise AssertionError('album not ready: %r' % status)

    def close(self):
        self.app.close()
        shutil.rmtree(self.cert_dir, ignore_errors=True)


class AlbumTestCase(unittest.TestCase):
    """A temporary directory, torn down after the test."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='lurker-album-')
        self.addCleanup(shutil.rmtree, self.root, True)

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def start(self, **kwargs):
        server = RunningLurker(**kwargs)
        self.addCleanup(server.close)
        return server
