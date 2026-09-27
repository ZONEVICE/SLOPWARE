"""HTTPS end to end: verified TLS, http:// typed by mistake, misbehaving clients."""
import socket
import ssl
import time
import unittest
import warnings

from tests.support import fixtures as fx
from tests.support.server import AlbumTestCase


class HttpsTests(AlbumTestCase):
    def setUp(self):
        super().setUp()
        fx.write(self.path('a.jpg'), fx.jpeg(16, 16))
        self.server = self.start(directory=self.root, protocol='https', password='pw')
        self.server.wait_ready()

    def test_verified_tls_for_pages_api_and_media(self):
        self.assertEqual(self.server.get('/login').status, 200)
        cookie = self.server.login('pw')
        state = self.server.get('/api/state', cookie=cookie).json()
        self.assertEqual(state['app']['protocol'], 'https')
        self.assertTrue(state['app']['url'].startswith('https://'))
        album = state['album']
        delta = self.server.get('/api/album/delta?album=%s&since=0' % album['id'], cookie=cookie).json()
        item = delta['items'][0]
        reply = self.server.get('/media/%s/%d/%s/a.jpg' % (album['id'], item['i'], item['v']), cookie=cookie)
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.body[:2], b'\xff\xd8')

    def test_cookie_is_secure_over_https(self):
        reply = self.server.request('POST', '/login', body=b'password=pw',
                                    headers={'Content-Type': 'application/x-www-form-urlencoded'})
        self.assertIn('Secure', reply.header('set-cookie'))

    def test_plain_http_on_the_https_port_is_redirected(self):
        with socket.create_connection(('127.0.0.1', self.server.port), timeout=10) as raw:
            raw.sendall(b'GET /some/page?x=1 HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n\r\n' % self.server.port)
            answer = b''
            while True:
                chunk = raw.recv(4096)
                if not chunk:
                    break
                answer += chunk
        head = answer.decode('latin-1')
        self.assertTrue(head.startswith('HTTP/1.1 307'), head)
        self.assertIn('Location: https://127.0.0.1:%d/some/page?x=1' % self.server.port, head)
        self.assertIn('Cache-Control: no-store', head)

    def test_refused_certificates_and_silent_clients_do_not_block_others(self):
        # A client that rejects the self-signed certificate (a browser before the user accepts it).
        strict = ssl.create_default_context()
        with socket.create_connection(('127.0.0.1', self.server.port), timeout=10) as raw:
            with self.assertRaises(ssl.SSLError):
                strict.wrap_socket(raw, server_hostname='localhost')
        # A client that connects and says nothing, holding its connection open.
        silent = socket.create_connection(('127.0.0.1', self.server.port), timeout=10)
        self.addCleanup(silent.close)
        time.sleep(0.2)
        started = time.time()
        self.assertEqual(self.server.get('/login').status, 200)
        self.assertLess(time.time() - started, 3)

    def test_old_tls_versions_are_refused(self):
        context = ssl._create_unverified_context()
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', DeprecationWarning)
                context.minimum_version = ssl.TLSVersion.TLSv1_1
                context.maximum_version = ssl.TLSVersion.TLSv1_1
        except (ValueError, AttributeError):
            self.skipTest('this OpenSSL cannot even offer TLS 1.1')
        with socket.create_connection(('127.0.0.1', self.server.port), timeout=10) as raw:
            with self.assertRaises((ssl.SSLError, OSError)):
                context.wrap_socket(raw, server_hostname='localhost')


if __name__ == '__main__':
    unittest.main()
