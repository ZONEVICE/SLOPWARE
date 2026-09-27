"""The optional password: everything is locked until a browser unlocks it."""
import http.client
import unittest

from tests.support import fixtures as fx
from tests.support.server import AlbumTestCase
from server.domain.auth import Auth
from server.domain.errors import AppError


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class AuthServiceTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.auth = Auth('open sesame', clock=self.clock)

    def test_disabled_without_a_password(self):
        auth = Auth(None)
        self.assertFalse(auth.enabled)
        self.assertTrue(auth.check(None, '1.2.3.4', 'agent'))

    def test_login_and_check(self):
        token = self.auth.login('open sesame', '10.0.0.5', 'Firefox on Linux')
        self.assertTrue(self.auth.check(token, '10.0.0.5', 'Firefox on Linux'))
        self.assertFalse(self.auth.check(token, '10.0.0.6', 'Firefox on Linux'))    # another IP
        self.assertFalse(self.auth.check(token, '10.0.0.5', 'Safari on iOS'))        # another browser/OS
        self.assertFalse(self.auth.check('forged', '10.0.0.5', 'Firefox on Linux'))
        self.assertFalse(self.auth.check(None, '10.0.0.5', 'Firefox on Linux'))

    def test_wrong_password(self):
        with self.assertRaises(AppError) as caught:
            self.auth.login('open sesame!', '10.0.0.5', 'x')
        self.assertEqual((caught.exception.status, caught.exception.code), (401, 'wrong_password'))
        with self.assertRaises(AppError):
            self.auth.login('', '10.0.0.5', 'x')

    def test_guessing_is_throttled_per_address(self):
        for _ in range(3):
            with self.assertRaises(AppError):
                self.auth.login('guess', '10.0.0.9', 'x')
        with self.assertRaises(AppError) as caught:
            self.auth.login('open sesame', '10.0.0.9', 'x')  # right password, but too soon
        self.assertEqual((caught.exception.status, caught.exception.code), (429, 'too_many_attempts'))
        self.assertGreaterEqual(caught.exception.extra['retryAfter'], 1)
        self.auth.login('open sesame', '10.0.0.10', 'x')   # another address is not affected
        self.clock.now += 1.5
        token = self.auth.login('open sesame', '10.0.0.9', 'x')
        self.assertTrue(self.auth.check(token, '10.0.0.9', 'x'))
        with self.assertRaises(AppError) as caught:   # success reset the counter
            self.auth.login('guess', '10.0.0.9', 'x')
        self.assertEqual(caught.exception.status, 401)

    def test_delay_doubles_up_to_a_minute(self):
        delays = []
        for _ in range(12):
            try:
                self.auth.login('guess', '10.0.0.7', 'x')
            except AppError:
                pass
            count, not_before = self.auth._failures['10.0.0.7']
            delays.append(round(not_before - self.clock.now, 3))
            self.clock.now = not_before
        self.assertEqual(delays[:6], [0.0, 0.0, 1.0, 2.0, 4.0, 8.0])
        self.assertEqual(delays[-1], 60.0)

    def test_logout_and_idle_expiry(self):
        token = self.auth.login('open sesame', '1.1.1.1', 'x')
        self.assertTrue(self.auth.logout(token))
        self.assertFalse(self.auth.check(token, '1.1.1.1', 'x'))
        token = self.auth.login('open sesame', '1.1.1.1', 'x')
        self.clock.now += 8 * 24 * 3600
        self.assertFalse(self.auth.check(token, '1.1.1.1', 'x'))


class LockedServerTests(AlbumTestCase):
    def setUp(self):
        super().setUp()
        fx.write(self.path('a.png'), fx.png(4, 4))
        self.server = self.start(directory=self.root, password='s3cret pass')
        self.server.wait_ready()

    def test_everything_is_blocked_before_unlocking(self):
        page = self.server.get('/')
        self.assertEqual((page.status, page.header('location')), (303, '/login'))
        for path in ('/js/main.js', '/css/base.css', '/index.html'):
            reply = self.server.get(path)
            self.assertEqual(reply.status, 303, path)
            self.assertTrue(reply.header('location').startswith('/login'), path)
        for path in ('/api/state', '/api/events', '/api/album/delta?since=0', '/media/x/0/v/a.png', '/thumb/x/0/v',
                     '/api/items/x/0', '/api/nothing-here'):
            reply = self.server.get(path)
            self.assertEqual(reply.status, 401, path)
            self.assertEqual(reply.json()['error']['code'], 'auth_required', path)
        for path, body in (('/api/album/close', {}), ('/api/album/open', {'path': '/'}), ('/api/paths/check', {'path': '/'})):
            self.assertEqual(self.server.post(path, body).status, 401, path)
        self.assertEqual(self.server.app.album.status()['status'], 'ready')

    def test_the_login_page_and_icon_are_public(self):
        page = self.server.get('/login')
        self.assertEqual(page.status, 200)
        self.assertIn(b'type="password"', page.body)
        self.assertIn(b'Lurker is locked', page.body)
        self.assertIn("style-src 'nonce-", page.header('content-security-policy'))
        self.assertEqual(self.server.get('/icon.svg').status, 200)

    def test_unlocking(self):
        wrong = self.server.request('POST', '/login', body=b'password=nope',
                                    headers={'Content-Type': 'application/x-www-form-urlencoded'})
        self.assertEqual(wrong.status, 401)
        self.assertIn(b'That password is not correct.', wrong.body)
        self.assertIsNone(wrong.header('set-cookie'))
        cookie = self.server.login('s3cret%20pass')
        name, value = cookie.split('=', 1)
        self.assertEqual(name, 'lurker_%d' % self.server.port)  # cookies ignore ports; the name does not
        reply = self.server.request('POST', '/login', body=b'password=s3cret+pass',
                                    headers={'Content-Type': 'application/x-www-form-urlencoded'})
        attributes = reply.header('set-cookie')
        self.assertIn('HttpOnly', attributes)
        self.assertIn('SameSite=Strict', attributes)
        self.assertNotIn('Secure', attributes)       # plain HTTP here
        self.assertNotIn('Max-Age', attributes)      # a session cookie
        state = self.server.get('/api/state', cookie=cookie)
        self.assertEqual(state.status, 200)
        self.assertTrue(state.json()['app']['auth'])
        self.assertEqual(self.server.get('/', cookie=cookie).status, 200)
        self.assertEqual(self.server.get('/login', cookie=cookie).status, 303)

    def test_a_session_is_bound_to_the_browser_and_address(self):
        cookie = self.server.login('s3cret%20pass', user_agent='Browser A')
        self.assertEqual(self.server.get('/api/state', cookie=cookie, headers={'User-Agent': 'Browser A'}).status, 200)
        self.assertEqual(self.server.get('/api/state', cookie=cookie, headers={'User-Agent': 'Browser B'}).status, 401)
        # The same cookie sent from another address of this machine.
        connection = http.client.HTTPConnection('127.0.0.1', self.server.port, timeout=10, source_address=('127.0.0.2', 0))
        try:
            connection.request('GET', '/api/state', headers={'Cookie': cookie, 'User-Agent': 'Browser A'})
        except OSError:
            self.skipTest('127.0.0.2 is not usable on this system')
        response = connection.getresponse()
        response.read()
        connection.close()
        self.assertEqual(response.status, 401)

    def test_logout(self):
        cookie = self.server.login('s3cret%20pass')
        reply = self.server.post('/api/auth/logout', cookie=cookie)
        self.assertEqual(reply.status, 200)
        self.assertIn('Max-Age=0', reply.header('set-cookie'))
        self.assertEqual(self.server.get('/api/state', cookie=cookie).status, 401)

    def test_login_returns_to_the_requested_page(self):
        redirect = self.server.get('/js/app.js')
        self.assertEqual(redirect.header('location'), '/login?next=/js/app.js')
        reply = self.server.request('POST', '/login', body=b'password=s3cret+pass&next=/js/app.js',
                                    headers={'Content-Type': 'application/x-www-form-urlencoded'})
        self.assertEqual(reply.header('location'), '/js/app.js')
        for unsafe in ('//evil.example/x', 'https://evil.example/', '/\\evil.example'):
            reply = self.server.request('POST', '/login', body=('password=s3cret+pass&next=%s' % unsafe).encode(),
                                        headers={'Content-Type': 'application/x-www-form-urlencoded'})
            self.assertEqual(reply.header('location'), '/', unsafe)

    def test_throttling_over_http(self):
        for _ in range(3):
            self.server.request('POST', '/login', body=b'password=guess',
                                headers={'Content-Type': 'application/x-www-form-urlencoded'})
        reply = self.server.request('POST', '/login', body=b'password=guess',
                                    headers={'Content-Type': 'application/x-www-form-urlencoded'})
        self.assertEqual(reply.status, 429)
        self.assertIsNotNone(reply.header('retry-after'))
        self.assertIn(b'Too many wrong passwords', reply.body)

    def test_any_host_name_is_fine_with_a_password(self):
        cookie = self.server.login('s3cret%20pass')
        reply = self.server.get('/api/state', cookie=cookie, headers={'Host': 'photos.example.com'})
        self.assertEqual(reply.status, 200)


class OpenServerTests(AlbumTestCase):
    def test_no_password_means_no_login(self):
        server = self.start()
        self.assertEqual(server.get('/api/state').status, 200)
        login = server.get('/login')
        self.assertEqual((login.status, login.header('location')), (303, '/'))
        self.assertFalse(server.get('/api/state').json()['app']['auth'])


if __name__ == '__main__':
    unittest.main()
