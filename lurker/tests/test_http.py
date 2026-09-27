"""The HTTP API, static files, media streaming and the request guards."""
import gzip
import http.client
import json
import os
import unittest
from urllib.parse import quote

from tests.support import fixtures as fx
from tests.support.server import AlbumTestCase
from server.media.readers import jpeg as jpeg_reader
from server.media.binary import BytesSource


class AlbumHttpCase(AlbumTestCase):
    """A server with the sample album open and fully read."""

    def setUp(self):
        super().setUp()
        self.files = fx.make_album(self.root)
        self.server = self.start(directory=self.root)
        self.status = self.server.wait_ready()
        self.album_id = self.status['id']
        delta = self.server.get('/api/album/delta?album=%s&since=0' % self.album_id).json()
        self.folders = {folder['i']: folder for folder in delta['folders']}
        self.items = {self.relative(item): item for item in delta['items']}

    def relative(self, wire):
        parts = []
        folder = self.folders.get(wire['d'])
        while folder and folder['p'] is not None:
            parts.insert(0, folder['n'])
            folder = self.folders.get(folder['p'])
        return '/'.join(parts + [wire['n']])

    def media_path(self, rel, download=False):
        wire = self.items[rel]
        return '/media/%s/%d/%s/%s%s' % (self.album_id, wire['i'], wire['v'], quote(wire['n']),
                                         '?download=1' if download else '')


class StaticTests(AlbumTestCase):
    def setUp(self):
        super().setUp()
        self.server = self.start()

    def test_index_and_assets(self):
        index = self.server.get('/')
        self.assertEqual(index.status, 200)
        self.assertTrue(index.header('content-type').startswith('text/html'))
        self.assertIn(b'<script type="module" src="/js/main.js">', index.body)
        self.assertIn("script-src 'self'", index.header('content-security-policy'))
        self.assertIn("frame-ancestors 'none'", index.header('content-security-policy'))
        for path, kind in (('/js/main.js', 'text/javascript'), ('/css/base.css', 'text/css'), ('/icon.svg', 'image/svg+xml'),
                           ('/js/views/grid.js', 'text/javascript')):
            reply = self.server.get(path)
            self.assertEqual(reply.status, 200, path)
            self.assertTrue(reply.header('content-type').startswith(kind), path)
            self.assertEqual(reply.header('cache-control'), 'no-cache')

    def test_etag_revalidation_and_gzip(self):
        first = self.server.get('/js/app.js', headers={'Accept-Encoding': 'gzip'})
        self.assertEqual(first.header('content-encoding'), 'gzip')
        self.assertIn(b'class App', gzip.decompress(first.body))
        again = self.server.get('/js/app.js', headers={'If-None-Match': first.header('etag')})
        self.assertEqual(again.status, 304)
        self.assertEqual(again.body, b'')

    def test_nothing_outside_public_is_reachable(self):
        for path in ('/../lurker.py', '/%2e%2e/lurker.py', '/js/../../server/app.py', '/js/%2e%2e/%2e%2e/lurker.py',
                     '/..%2flurker.py', '/.gitignore', '/js/.hidden.js', '/missing.js', '/index.html%00.js',
                     '/server/app.py', '/version.txt'):
            reply = self.server.get(path)
            self.assertEqual(reply.status, 404, path)
            self.assertNotIn(b'import', reply.body, path)

    def test_security_headers_everywhere(self):
        for path in ('/', '/api/state', '/nope', '/icon.svg'):
            reply = self.server.get(path)
            self.assertEqual(reply.header('x-content-type-options'), 'nosniff', path)
            self.assertEqual(reply.header('referrer-policy'), 'no-referrer', path)
            self.assertEqual(reply.header('x-frame-options'), 'DENY', path)
            self.assertEqual(reply.header('server'), 'Lurker', path)

    def test_methods(self):
        reply = self.server.get('/api/album/open')
        self.assertEqual(reply.status, 405)
        self.assertEqual(reply.json()['error']['code'], 'method_not_allowed')


class StateAndPathTests(AlbumTestCase):
    def setUp(self):
        super().setUp()
        self.server = self.start()

    def test_state(self):
        state = self.server.get('/api/state').json()
        self.assertEqual(state['app']['name'], 'Lurker')
        self.assertEqual(state['app']['version'], '1.0.0')
        self.assertEqual(state['app']['protocol'], 'http')
        self.assertEqual(state['app']['port'], self.server.port)
        self.assertFalse(state['app']['auth'])
        self.assertEqual(state['album']['status'], 'empty')
        self.assertIn('jpeg', [fmt['key'] for fmt in state['formats']])
        self.assertEqual(state['shortcuts'][0]['label'], 'Home')
        self.assertEqual(self.server.get('/api/state').header('cache-control'), 'no-store')

    def test_path_check(self):
        ok = self.server.post('/api/paths/check', {'path': self.root}).json()
        self.assertTrue(ok['ok'])
        self.assertNotIn('real', ok)
        bad = self.server.post('/api/paths/check', {'path': 'relative'}).json()
        self.assertEqual((bad['ok'], bad['code']), (False, 'not_absolute'))

    def test_json_is_required(self):
        reply = self.server.request('POST', '/api/paths/check', body=b'path=/tmp',
                                    headers={'Content-Type': 'application/x-www-form-urlencoded'})
        self.assertEqual(reply.status, 415)
        broken = self.server.request('POST', '/api/paths/check', body=b'{nope', headers={'Content-Type': 'application/json'})
        self.assertEqual((broken.status, broken.json()['error']['code']), (400, 'bad_json'))
        array = self.server.request('POST', '/api/paths/check', body=b'[]', headers={'Content-Type': 'application/json'})
        self.assertEqual(array.status, 400)

    def test_suggestions(self):
        os.mkdir(self.path('Holidays'))
        os.mkdir(self.path('home-videos'))
        reply = self.server.get('/api/paths/suggest?path=%s' % quote(self.path('ho')))
        self.assertEqual([os.path.basename(p) for p in reply.json()['suggestions']], ['Holidays', 'home-videos'])

    def test_open_close_cycle(self):
        fx.write(self.path('one.png'), fx.png(4, 4))
        opened = self.server.post('/api/album/open', {'path': self.root})
        self.assertEqual(opened.status, 202)
        self.assertIn(opened.json()['status'], ('scanning', 'ready'))
        again = self.server.post('/api/album/open', {'path': self.root})
        self.assertEqual((again.status, again.json()['error']['code']), (409, 'album_open'))
        self.server.wait_ready()
        closed = self.server.post('/api/album/close')
        self.assertEqual(closed.status, 200)
        self.assertEqual(closed.json()['status'], 'empty')
        self.assertEqual(closed.json()['recent'][0]['path'], os.path.normpath(self.root))
        self.assertEqual(self.server.get('/api/album/delta?since=0').json()['error']['code'], 'no_album')

    def test_open_refuses_bad_paths(self):
        for raw, code in (('', 'empty'), ('some/relative', 'not_absolute'), (self.path('missing'), 'not_found')):
            reply = self.server.post('/api/album/open', {'path': raw})
            self.assertEqual((reply.status, reply.json()['error']['code']), (400, code))

    def test_close_needs_a_json_body(self):
        reply = self.server.request('POST', '/api/album/close', body=b'', headers={'Content-Type': 'text/plain'})
        self.assertEqual(reply.status, 415)


class CatalogHttpTests(AlbumHttpCase):
    def test_full_catalog(self):
        self.assertEqual(set(self.items), {
            'beach.jpg', 'sunset.png', 'spinner.gif', 'clip.webm', 'trips/2022/paris.jpg', 'trips/2022/louvre.bmp',
            'trips/2022/raw/IMG_0001.CR2', '.hidden/secret.jpg', 'videos/movie.mp4', 'videos/phone.mkv',
            'videos/old.avi', 'videos/stream.ts'})
        beach = self.items['beach.jpg']
        self.assertEqual((beach['f'], beach['w'], beach['h'], beach['o'], beach['c'], beach['r']),
                         ('jpeg', 48, 64, 6, 'Canon EOS R5', 1))
        self.assertEqual(beach['m'], 1700000000)
        self.assertEqual(self.items['videos/movie.mp4']['u'], 12.5)
        self.assertEqual(self.items['videos/movie.mp4']['z'], 1)
        self.assertEqual(self.items['spinner.gif']['a'], 1)
        self.assertEqual(self.items['.hidden/secret.jpg']['x'], 1)
        self.assertEqual(self.items['trips/2022/raw/IMG_0001.CR2']['r'], 1)

    def test_gzip_and_incremental_sync(self):
        packed = self.server.get('/api/album/delta?album=%s&since=0' % self.album_id, headers={'Accept-Encoding': 'gzip'})
        self.assertEqual(packed.header('content-encoding'), 'gzip')
        full = json.loads(gzip.decompress(packed.body))
        self.assertTrue(full['full'])
        rev = full['rev']
        nothing = self.server.get('/api/album/delta?album=%s&since=%d' % (self.album_id, rev)).json()
        self.assertEqual((nothing['items'], nothing['removedItems'], nothing['full']), ([], [], False))
        os.remove(self.path('sunset.png'))
        fx.write(self.path('added.gif'), fx.gif(3, 3))
        self.assertEqual(self.server.post('/api/album/rescan', {'album': self.album_id}).status, 202)
        self.server.wait_ready()
        delta = self.server.get('/api/album/delta?album=%s&since=%d' % (self.album_id, rev)).json()
        self.assertEqual([item['n'] for item in delta['items']], ['added.gif'])
        self.assertEqual(delta['removedItems'], [self.items['sunset.png']['i']])

    def test_stale_or_bad_requests(self):
        self.assertEqual(self.server.get('/api/album/delta?album=elsewhere&since=0').status, 409)
        self.assertEqual(self.server.get('/api/album/delta?album=%s&since=x' % self.album_id).status, 400)

    def test_details(self):
        reply = self.server.get('/api/items/%s/%d' % (self.album_id, self.items['beach.jpg']['i']))
        details = reply.json()
        self.assertEqual(details['path'], 'beach.jpg')
        self.assertEqual(details['details']['iso'], 100)
        self.assertAlmostEqual(details['details']['latitude'], 36.5, places=3)
        self.assertEqual(self.server.get('/api/items/%s/99999' % self.album_id).status, 404)


class MediaTests(AlbumHttpCase):
    def test_original_file(self):
        reply = self.server.get(self.media_path('sunset.png'))
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.body, self.files['sunset.png'])
        self.assertEqual(reply.header('content-type'), 'image/png')
        self.assertEqual(reply.header('accept-ranges'), 'bytes')
        self.assertTrue(reply.header('content-disposition').startswith('inline;'))
        self.assertIn('sandbox', reply.header('content-security-policy'))
        self.assertIn('max-age', reply.header('cache-control'))

    def test_download(self):
        reply = self.server.get(self.media_path('trips/2022/paris.jpg', download=True))
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.header('content-disposition'),
                         'attachment; filename="paris.jpg"; filename*=UTF-8\'\'paris.jpg')

    def test_ranges(self):
        path = self.media_path('clip.webm')
        data = fx.TINY_WEBM
        part = self.server.get(path, headers={'Range': 'bytes=0-9'})
        self.assertEqual(part.status, 206)
        self.assertEqual(part.body, data[:10])
        self.assertEqual(part.header('content-range'), 'bytes 0-9/%d' % len(data))
        tail = self.server.get(path, headers={'Range': 'bytes=-5'})
        self.assertEqual((tail.status, tail.body), (206, data[-5:]))
        rest = self.server.get(path, headers={'Range': 'bytes=800-'})
        self.assertEqual((rest.status, rest.body), (206, data[800:]))
        clipped = self.server.get(path, headers={'Range': 'bytes=840-99999'})
        self.assertEqual(clipped.body, data[840:])
        outside = self.server.get(path, headers={'Range': 'bytes=5000-6000'})
        self.assertEqual(outside.status, 416)
        self.assertEqual(outside.header('content-range'), 'bytes */%d' % len(data))
        multiple = self.server.get(path, headers={'Range': 'bytes=0-1,4-5'})
        self.assertEqual((multiple.status, multiple.body), (200, data))

    def test_conditional_requests(self):
        path = self.media_path('sunset.png')
        first = self.server.get(path)
        again = self.server.get(path, headers={'If-None-Match': first.header('etag')})
        self.assertEqual((again.status, again.body), (304, b''))
        since = self.server.get(path, headers={'If-Modified-Since': first.header('last-modified')})
        self.assertEqual(since.status, 304)
        stale_range = self.server.get(path, headers={'Range': 'bytes=0-3', 'If-Range': '"other"'})
        self.assertEqual(stale_range.status, 200)
        good_range = self.server.get(path, headers={'Range': 'bytes=0-3', 'If-Range': first.header('etag')})
        self.assertEqual(good_range.status, 206)

    def test_head(self):
        reply = self.server.request('HEAD', self.media_path('sunset.png'))
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.body, b'')
        self.assertEqual(int(reply.header('content-length')), len(self.files['sunset.png']))

    def test_embedded_preview_carries_the_orientation(self):
        wire = self.items['beach.jpg']
        reply = self.server.get('/thumb/%s/%d/%s' % (self.album_id, wire['i'], wire['v']))
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.header('content-type'), 'image/jpeg')
        info = jpeg_reader.read(BytesSource(reply.body))
        self.assertEqual((info['width'], info['height'], info['orientation']), (160, 120, 6))
        png = self.items['sunset.png']
        missing = self.server.get('/thumb/%s/%d/%s' % (self.album_id, png['i'], png['v']))
        self.assertEqual((missing.status, missing.json()['error']['code']), (404, 'no_preview'))

    def test_raw_preview(self):
        wire = self.items['trips/2022/raw/IMG_0001.CR2']
        reply = self.server.get('/thumb/%s/%d/%s' % (self.album_id, wire['i'], wire['v']))
        self.assertEqual(reply.status, 200)
        self.assertEqual(jpeg_reader.read(BytesSource(reply.body))['width'], 120)

    def test_unknown_ids_and_albums(self):
        self.assertEqual(self.server.get('/media/%s/9999/x/y.jpg' % self.album_id).status, 404)
        self.assertEqual(self.server.get('/media/nope/0/x/y.jpg').status, 409)
        self.assertEqual(self.server.get('/media/%s/abc/x/y.jpg' % self.album_id).status, 404)

    def test_files_changed_after_the_scan(self):
        os.remove(self.path('sunset.png'))
        self.assertEqual(self.server.get(self.media_path('sunset.png')).status, 404)
        if hasattr(os, 'symlink'):
            os.remove(self.path('beach.jpg'))
            os.symlink(os.path.join(self.root, 'trips', '2022', 'paris.jpg'), self.path('beach.jpg'))
            self.assertEqual(self.server.get(self.media_path('beach.jpg')).status, 404)

    def test_awkward_names(self):
        name = 'Año nuevo #1 ? 100% (copy).jpg'
        fx.write(self.path(name), fx.jpeg(8, 8))
        self.server.post('/api/album/rescan', {'album': self.album_id})
        self.server.wait_ready()
        delta = self.server.get('/api/album/delta?album=%s&since=0' % self.album_id).json()
        wire = next(item for item in delta['items'] if item['n'] == name)
        reply = self.server.get('/media/%s/%d/%s/%s?download=1' % (self.album_id, wire['i'], wire['v'], quote(name)))
        self.assertEqual(reply.status, 200)
        self.assertIn("filename*=UTF-8''A%C3%B1o%20nuevo%20%231%20%3F%20100%25%20%28copy%29.jpg",
                      reply.header('content-disposition'))


class ConnectionTests(AlbumHttpCase):
    def test_keep_alive_survives_bodies_and_errors(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.port, timeout=10)
        self.addCleanup(connection.close)
        requests = [
            ('POST', '/api/paths/check', json.dumps({'path': self.root}).encode(), {'Content-Type': 'application/json'}, 200),
            ('POST', '/api/nowhere', b'{"x": 1}', {'Content-Type': 'application/json'}, 404),
            ('POST', '/api/album/close', b'not json', {'Content-Type': 'text/plain'}, 415),
            ('GET', '/api/state', None, {}, 200),
            ('GET', self.media_path('sunset.png'), None, {'Range': 'bytes=0-3'}, 206),
            ('GET', '/api/state', None, {}, 200),
        ]
        for method, path, body, headers, expected in requests:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, expected, path)
            self.assertNotEqual(response.getheader('Connection'), 'close', path)


class GuardTests(AlbumHttpCase):
    def test_cross_site_writes_are_refused(self):
        for headers in ({'Origin': 'http://evil.example'}, {'Sec-Fetch-Site': 'cross-site'},
                        {'Origin': 'http://127.0.0.1:1', 'Sec-Fetch-Site': 'same-site'}):
            reply = self.server.post('/api/album/close', headers=headers)
            self.assertEqual((reply.status, reply.json()['error']['code']), (403, 'cross_site'), headers)
        self.assertEqual(self.server.app.album.status()['status'], 'ready')
        own = self.server.post('/api/paths/check', {'path': '/'},
                               headers={'Origin': 'http://127.0.0.1:%d' % self.server.port, 'Sec-Fetch-Site': 'same-origin'})
        self.assertEqual(own.status, 200)

    def test_only_local_host_names_without_a_password(self):
        for host in ('evil.example', 'photos.example.com:8080', 'attacker.io'):
            self.assertEqual(self.server.get('/api/state', headers={'Host': host}).status, 421, host)
        for host in ('127.0.0.1:%d' % self.server.port, 'localhost', '192.168.1.20:8080', '[::1]:8080', 'nas',
                     'nas.local', 'box.lan', 'pc.home.arpa', self.server.app.identity.hostname):
            self.assertEqual(self.server.get('/api/state', headers={'Host': host}).status, 200, host)


if __name__ == '__main__':
    unittest.main()
