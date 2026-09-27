"""The whole application in headless Chromium, driven over the DevTools pipe.

Skipped when no Chromium/Chrome is installed (or LURKER_SKIP_BROWSER_TESTS=1).
Set LURKER_TEST_SCREENSHOTS=<directory> to keep a screenshot of each screen.
"""
import json
import os
import shutil
import tempfile
import time
import unittest

from tests.support import fixtures as fx
from tests.support.browser import Browser, find_browser
from tests.support.server import RunningLurker

SCREENSHOTS = os.environ.get('LURKER_TEST_SCREENSHOTS')
ALL_ITEMS = 12


@unittest.skipUnless(find_browser(), 'Chromium/Chrome not installed')
class BrowserTestCase(unittest.TestCase):
    width, height, mobile = 1360, 900, False

    @classmethod
    def setUpClass(cls):
        cls.browser = Browser(cls.width, cls.height)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='lurker-browser-')
        self.addCleanup(shutil.rmtree, self.root, True)
        self.files = fx.make_album(self.root)
        self.pages = []

    def tearDown(self):
        for page in self.pages:
            errors = [error for error in page.errors if 'favicon' not in (error or '')]
            page.close()
            self.assertEqual(errors, [], 'JavaScript errors in the page')

    def serve(self, **kwargs):
        server = RunningLurker(**kwargs)
        self.addCleanup(server.close)
        return server

    def open_page(self, url, **kwargs):
        page = self.browser.new_page(url, width=kwargs.get('width', self.width), height=kwargs.get('height', self.height),
                                     mobile=kwargs.get('mobile', self.mobile), scale=kwargs.get('scale', 1))
        self.pages.append(page)
        return page

    def shot(self, page, name):
        if SCREENSHOTS:
            os.makedirs(SCREENSHOTS, exist_ok=True)
            page.screenshot(os.path.join(SCREENSHOTS, '%s.png' % name))

    def tiles(self, page):
        return page.evaluate('document.querySelectorAll("#view .tile").length')

    def wait_tiles(self, page, count, timeout=15):
        page.wait_for('document.querySelectorAll("#view .tile").length === %d' % count, timeout=timeout,
                      message='expected %d tiles' % count)

    def go(self, page, server, hash_):
        page.evaluate('location.hash = %s' % json.dumps(hash_))
        time.sleep(0.15)


class StartScreenTests(BrowserTestCase):
    def test_choose_a_directory_then_browse_it(self):
        server = self.serve()
        page = self.open_page(server.base + '/')
        page.wait_for('document.querySelector("#album-path")')
        self.assertIn('Open an album', page.text('h1'))
        page.type('#album-path', 'relative/path')
        page.wait_for('document.querySelector(".path-status.bad")')
        self.assertIn('absolute path', page.text('.path-status'))
        page.type('#album-path', os.path.join(self.root, 'tr'))
        page.wait_for('document.querySelectorAll(".suggestions button").length === 2')  # trips and trips-link
        self.assertEqual(page.text('.suggestions button span'), os.path.join(self.root, 'trips'))
        page.type('#album-path', self.root)
        page.wait_for('document.querySelector(".path-status.ok")')
        self.shot(page, 'start')
        page.key('Enter', 'Enter', 13)
        self.wait_tiles(page, ALL_ITEMS)
        self.assertEqual(page.evaluate('document.title'), '%s · Lurker' % os.path.basename(self.root))
        self.assertEqual(server.app.album.status()['root'], os.path.normpath(self.root))

    def test_command_line_directory_skips_the_form(self):
        server = self.serve(directory=self.root)
        page = self.open_page(server.base + '/')
        self.wait_tiles(page, ALL_ITEMS)
        self.assertFalse(page.exists('#album-path'))

    def test_unusable_command_line_directory_shows_the_form_with_a_notice(self):
        server = self.serve(directory=os.path.join(self.root, 'missing'))
        page = self.open_page(server.base + '/')
        page.wait_for('document.querySelector(".notice")')
        self.assertIn('could not be opened', page.text('.notice'))
        self.assertTrue(page.exists('#album-path'))


class GalleryTests(BrowserTestCase):
    def setUp(self):
        super().setUp()
        self.server = self.serve(directory=self.root)
        self.server.wait_ready()
        self.page = self.open_page(self.server.base + '/')
        self.wait_tiles(self.page, ALL_ITEMS)

    def test_images_and_video_posters_load(self):
        page = self.page
        # Every browser-displayable image, the RAW's embedded preview and the WebM's captured frame.
        page.wait_for('document.querySelectorAll(".tile-img.loaded").length === 8', timeout=20,
                      message='8 pictures expected (6 images, 1 RAW preview, 1 video poster)')
        broken = page.evaluate('[...document.querySelectorAll(".tile-placeholder .format")].map(e => e.textContent).sort()')
        self.assertEqual(broken, ['AVI', 'MKV', 'MP4', 'TS'])  # header-only fixtures and unplayable formats
        self.assertTrue(page.evaluate('document.querySelector(".tile-video .tile-img.loaded").src.startsWith("blob:")'))
        self.assertEqual(page.evaluate('[...document.querySelectorAll(".tile-badge")].map(e => e.textContent).sort()'),
                         ['0:02', '0:08', '0:10', '0:13', 'GIF', 'RAW'])
        self.shot(page, 'grid')

    def test_kind_search_and_counts(self):
        page = self.page
        counts = page.evaluate('[...document.querySelectorAll(".kinds button .count")].map(e => e.textContent)')
        self.assertEqual(counts, ['12', '7', '5'])
        page.click('.kinds button:nth-child(3)')
        self.wait_tiles(page, 5)
        self.assertIn('kind=video', page.evaluate('location.hash'))
        page.click('.kinds button:nth-child(2)')
        self.wait_tiles(page, 7)
        page.click('.kinds button:nth-child(1)')
        page.type('.search input', 'paris')
        self.wait_tiles(page, 1)
        page.type('.search input', 'TRIPS')     # folder names count, case does not
        self.wait_tiles(page, 3)
        page.type('.search input', 'nothing-like-this')
        page.wait_for('document.querySelector(".empty h2") && document.querySelector(".empty h2").textContent === "Nothing matches"')
        page.click('.empty .btn')
        self.wait_tiles(page, ALL_ITEMS)

    def test_advanced_filters(self):
        page = self.page
        cases = {
            'types=png,gif': 2,
            'hidden=0': 11,
            'minsize=1048576': 0,
            'maxsize=1100': sum(1 for data in self.files.values() if len(data) <= 1100),
            'orient=portrait': 3,  # beach.jpg (EXIF orientation), paris.jpg, and the rotated movie.mp4
            'orient=landscape': 6,
            'from=2022-05-01&to=2022-05-02': 3,
            'date=taken&from=2023-01-01': 1,
            'mindur=9': 2,
            'animated=1': 1,
            'camera=NIKON%20D750': 1,
            'viewable=1&kind=image': 6,
        }
        for query, expected in cases.items():
            with self.subTest(query=query):
                self.go(page, self.server, '#/grid?%s' % query)
                if expected:
                    self.wait_tiles(page, expected)
                else:
                    page.wait_for('document.querySelector(".empty")')
        self.go(page, self.server, '#/grid?types=png,gif&hidden=0')
        self.wait_tiles(page, 2)
        self.assertEqual(page.text('.toolbar .icon-btn .count-badge'), '2')
        self.assertEqual(page.evaluate('document.querySelectorAll(".chips .chip").length'), 2)
        page.click('.toolbar .icon-btn[aria-label="Filters"]')
        page.wait_for('!document.querySelector(".filters").hidden')
        labels = page.evaluate('[...document.querySelectorAll(".filters .type-group .check span:nth-child(2)")].map(e => e.textContent)')
        self.assertIn('Camera RAW', labels)
        self.shot(page, 'filters')
        page.click('.filters footer .btn')  # Reset
        self.wait_tiles(page, ALL_ITEMS)

    def test_sorting(self):
        page = self.page
        self.go(page, self.server, '#/grid?sort=name&dir=asc')
        self.wait_tiles(page, ALL_ITEMS)
        names = page.evaluate('[...document.querySelectorAll("#view .tile")].map(t => t.title)')
        self.assertEqual(names, sorted(names, key=str.lower))
        self.go(page, self.server, '#/grid?sort=size')
        time.sleep(0.3)
        sizes = page.evaluate('window.lurker.ctx.items.map(i => i.size)')
        self.assertEqual(sizes, sorted(sizes, reverse=True))
        self.go(page, self.server, '#/grid')
        time.sleep(0.3)
        order = page.evaluate('window.lurker.ctx.items.map(i => i.name)')
        # "Best" date: the capture date, else the earliest file date (these files were all
        # created just now, so their modification times decide).
        self.assertEqual(order[:4], ['clip.webm', 'beach.jpg', 'louvre.bmp', 'IMG_0001.CR2'])

    def test_views(self):
        page = self.page
        self.go(page, self.server, '#/folders')
        page.wait_for('document.querySelectorAll(".folder-card").length === 3')
        cards = page.evaluate('[...document.querySelectorAll(".folder-card .name span")].map(e => e.textContent)')
        self.assertEqual(cards, ['.hidden', 'trips', 'videos'])
        self.assertEqual(self.tiles(page) - page.evaluate('document.querySelectorAll(".folder-cover .tile").length'), 4)
        self.shot(page, 'folders')
        page.click('.folder-card:nth-child(2)')  # trips
        page.wait_for('location.hash.includes("folder=")')
        page.wait_for('document.querySelectorAll(".folder-card").length === 1')  # 2022
        page.click('.folder-card')
        page.wait_for('document.querySelectorAll(".folder-card").length === 1')  # raw
        self.assertEqual(page.evaluate('document.querySelectorAll(".crumbs button").length'), 3)
        page.click('.crumbs .switch input')  # include subfolders
        page.wait_for('location.hash.includes("sub=1")')
        # A reload comes back to the same folder.
        page.reload()
        page.wait_for('document.querySelectorAll(".crumbs button").length === 3')
        self.assertEqual(page.evaluate('document.querySelector(".crumbs .switch input").checked'), True)

        self.go(page, self.server, '#/tree')
        page.wait_for('document.querySelectorAll(".tree-node").length === 4')  # the root and its three folders
        labels = page.evaluate('[...document.querySelectorAll(".tree-node .label")].map(e => e.textContent)')
        self.assertEqual(labels[1:], ['.hidden', 'trips', 'videos'])
        page.click('.tree-node:nth-child(3) .twisty')  # expand "trips"
        page.wait_for('[...document.querySelectorAll(".tree-node .label")].some(e => e.textContent === "2022")')
        page.click('.tree-node:nth-child(4)')  # select "2022"
        page.wait_for('document.querySelector(".pane-head h2").textContent === "2022"')
        self.wait_tiles(page, 2)  # paris.jpg and louvre.bmp; the RAW is in a subfolder
        self.shot(page, 'tree')

        self.go(page, self.server, '#/timeline?group=year')
        page.wait_for('document.querySelectorAll(".section-head h2").length >= 5')
        years = page.evaluate('[...document.querySelectorAll(".section-head h2")].map(e => e.textContent)')
        self.assertEqual(years[:3], ['2023', '2022', '2021'])
        self.shot(page, 'timeline')

        self.go(page, self.server, '#/list')
        page.wait_for('document.querySelectorAll(".list-row").length === %d' % ALL_ITEMS)
        page.click('.list-head .col-size')
        page.wait_for('location.hash.includes("sort=size")')
        self.shot(page, 'list')

    def test_viewer(self):
        page = self.page
        self.go(page, self.server, '#/grid?sort=name&dir=asc')
        self.wait_tiles(page, ALL_ITEMS)
        page.click('#view .tile[title="beach.jpg"]')
        page.wait_for('document.querySelector(".viewer")')
        page.wait_for('location.hash.includes("item=")')
        page.wait_for('document.querySelector(".viewer-canvas img") && document.querySelector(".viewer-canvas img").complete')
        self.assertEqual(page.text('.viewer-title .name'), 'beach.jpg')
        self.assertIn('48 × 64', page.text('.viewer-title .sub'))
        # EXIF orientation 6: the browser shows the 64x48 JPEG as 48x64.
        self.assertEqual(page.evaluate('[document.querySelector(".viewer-canvas img").naturalWidth, document.querySelector(".viewer-canvas img").naturalHeight]'), [48, 64])
        before = page.text('.viewer-zoom')
        page.key('+', 'Equal', 187)
        page.wait_for('document.querySelector(".viewer-zoom").textContent !== %s' % json.dumps(before))
        page.key('0', 'Digit0', 48)
        page.wait_for('document.querySelector(".viewer-zoom").textContent === %s' % json.dumps(before))
        page.key('r', 'KeyR', 82)
        page.key('i', 'KeyI', 73)
        page.wait_for('document.querySelector(".viewer-info dl") && document.querySelector(".viewer-info").textContent.includes("Canon EOS R5")')
        page.wait_for('document.querySelector(".viewer-info").textContent.includes("ISO")')
        self.assertIn('?download=1', page.evaluate('document.querySelector(".viewer-bar a[download]").href'))
        self.shot(page, 'viewer')
        # The mouse wheel zooms around the pointer.
        page.key('0', 'Digit0', 48)
        page.key('i', 'KeyI', 73)  # close the information panel again
        fit = page.text('.viewer-zoom')
        page.mouse('mouseWheel', 500, 450, delta_y=-400)
        page.wait_for('document.querySelector(".viewer-zoom").textContent !== %s' % json.dumps(fit))
        page.key('ArrowRight', 'ArrowRight', 39)
        page.wait_for('document.querySelector(".viewer-title .name").textContent === "clip.webm"')
        page.wait_for('(() => { const v = document.querySelector(".viewer video"); return v && v.readyState >= 2 && !v.error; })()')
        page.key('ArrowLeft', 'ArrowLeft', 37)
        page.wait_for('document.querySelector(".viewer-title .name").textContent === "beach.jpg"')
        page.key('Escape', 'Escape', 27)
        page.wait_for('!document.querySelector(".viewer")')
        page.wait_for('!location.hash.includes("item=")')

    def test_slideshow(self):
        page = self.page
        self.go(page, self.server, '#/grid?kind=image&sort=name&dir=asc')
        self.wait_tiles(page, 7)
        page.click('#view .tile')
        page.wait_for('document.querySelector(".viewer")')
        first = page.text('.viewer-title .name')
        page.key('s', 'KeyS', 83)
        page.wait_for('!document.querySelector(".viewer-bar select").hidden')
        page.evaluate('(() => { const s = document.querySelector(".viewer-bar select"); s.value = "2"; s.dispatchEvent(new Event("change")); return true; })()')
        page.wait_for('document.querySelector(".viewer-title .name").textContent !== %s' % json.dumps(first), timeout=6)
        page.key('s', 'KeyS', 83)
        page.wait_for('document.querySelector(".viewer-bar select").hidden')

    def test_back_button_closes_the_viewer(self):
        page = self.page
        page.click('#view .tile')
        page.wait_for('document.querySelector(".viewer")')
        page.evaluate('history.back()')
        page.wait_for('!document.querySelector(".viewer")')
        self.assertTrue(page.exists('#view .tile'))

    def test_unplayable_video_offers_a_download(self):
        page = self.page
        page.click('#view .tile[title="old.avi"]')
        page.wait_for('document.querySelector(".viewer-message")')
        self.assertIn('cannot play', page.text('.viewer-message'))
        self.assertIn('?download=1', page.evaluate('document.querySelector(".viewer-message a").href'))

    def test_deep_link_opens_the_viewer(self):
        item = next(entry for entry in self.server.app.album.session.catalog.items if entry.name == 'sunset.png')
        page = self.open_page(self.server.base + '/#/grid?item=%d' % item.id)
        page.wait_for('document.querySelector(".viewer-title .name") && document.querySelector(".viewer-title .name").textContent === "sunset.png"')

    def test_client_side_logic(self):
        result = self.page.evaluate('''(async () => {
            const query = await import('/js/core/query.js');
            const layout = await import('/js/core/layout.js');
            const format = await import('/js/core/format.js');
            const filters = await import('/js/components/filters.js');
            const items = [
                { id: 1, name: 'b.jpg', kind: 'image', size: 10, mtime: 100, taken: null, birth: null, width: 400, height: 300, duration: null, hidden: false, animated: false, camera: null, format: { key: 'jpeg', label: 'JPEG' } },
                { id: 2, name: 'a.mp4', kind: 'video', size: 30, mtime: 300, taken: null, birth: null, width: 1920, height: 1080, duration: 65, hidden: true, animated: false, camera: null, format: { key: 'mp4', label: 'MP4' } },
                { id: 3, name: 'c.png', kind: 'image', size: 20, mtime: 200, taken: null, birth: null, width: 100, height: 400, duration: null, hidden: false, animated: false, camera: null, format: { key: 'png', label: 'PNG' } },
            ];
            const context = { searchKey: (item) => item.name, viewable: () => true, folderPath: () => '' };
            const byName = query.sortItems(items, 'name', 'asc', context).map((i) => i.id);
            const bySize = query.sortItems(items, 'size', 'desc', context).map((i) => i.id);
            const videos = query.filterItems(items, { kind: 'video' }, context).map((i) => i.id);
            const portrait = query.filterItems(items, { orientation: 'portrait' }, context).map((i) => i.id);
            const visible = query.filterItems(items, { hidden: false }, context).map((i) => i.id);
            const rows = layout.justifiedRows(Array.from({ length: 40 }, (_, i) => ({ w: 3 + (i % 4), h: 2 })), 1000,
                { target: 150, gap: 4, aspect: (x) => x.w / x.h }).rows;
            const fullRows = rows.slice(0, -1).map((row) => row.widths.reduce((a, b) => a + b, 0) + 4 * (row.widths.length - 1));
            const params = query.filtersToParams({ ...query.DEFAULT_FILTERS, kind: 'image', types: ['png'], minSize: 5 }, new URLSearchParams());
            const back = query.filtersFromParams(params);
            return {
                byName, bySize, videos, portrait, visible, fullRows,
                bytes: [format.bytes(0), format.bytes(1536), format.bytes(5 * 1024 * 1024), format.bytes(3.5 * 1024 ** 3)],
                durations: [format.duration(65), format.duration(3723), format.duration(null)],
                parsed: [filters.parseDuration('90'), filters.parseDuration('1:30'), filters.parseDuration('1:02:03'), filters.parseDuration('')],
                query: params.toString(), back: [back.kind, back.types, back.minSize],
            };
        })()''')
        self.assertEqual(result['byName'], [2, 1, 3])
        self.assertEqual(result['bySize'], [2, 3, 1])
        self.assertEqual(result['videos'], [2])
        self.assertEqual(result['portrait'], [3])
        self.assertEqual(result['visible'], [1, 3])
        self.assertEqual(set(result['fullRows']), {1000})
        self.assertEqual(result['bytes'], ['0 B', '1.5 KB', '5 MB', '3.5 GB'])
        self.assertEqual(result['durations'], ['1:05', '1:02:03', ''])
        self.assertEqual(result['parsed'], [90, 90, 3723, None])
        self.assertEqual(result['query'], 'kind=image&types=png&minsize=5')
        self.assertEqual(result['back'], ['image', ['png'], 5])


class SharedAlbumTests(BrowserTestCase):
    def test_everyone_sees_the_same_album_and_the_close(self):
        server = self.serve(directory=self.root)
        server.wait_ready()
        first = self.open_page(server.base + '/')
        second = self.open_page(server.base + '/')
        self.wait_tiles(first, ALL_ITEMS)
        self.wait_tiles(second, ALL_ITEMS)
        first.front()
        first.click('.topbar .btn')  # Close album
        first.wait_for('document.querySelector("dialog.dialog[open]")')
        first.click('dialog .btn.primary')
        first.wait_for('document.querySelector("#album-path")')
        second.wait_for('document.querySelector("#album-path")')
        second.wait_for('document.querySelector(".toast") && document.querySelector(".toast").textContent.includes("closed")')
        self.assertEqual(server.app.album.status()['status'], 'empty')
        # Opening a new album from one browser shows it in the other.
        second.front()
        second.type('#album-path', os.path.join(self.root, 'trips'))
        second.key('Enter', 'Enter', 13)
        self.wait_tiles(second, 3)
        self.wait_tiles(first, 3)

    def test_new_files_appear_after_a_rescan(self):
        server = self.serve(directory=self.root)
        server.wait_ready()
        page = self.open_page(server.base + '/')
        self.wait_tiles(page, ALL_ITEMS)
        fx.write(os.path.join(self.root, 'late', 'arrival.png'), fx.png(30, 30))
        page.click('.topbar .icon-btn[aria-label="Rescan the directory"]')
        self.wait_tiles(page, ALL_ITEMS + 1)


class PasswordTests(BrowserTestCase):
    def test_login_flow(self):
        server = self.serve(directory=self.root, password='open sesame', protocol='https')
        server.wait_ready()
        page = self.open_page(server.base + '/#/grid?kind=video')
        page.wait_for('location.pathname === "/login"')
        page.type('#password', 'wrong')
        page.evaluate('document.querySelector("form").requestSubmit()')
        page.wait_for('document.querySelector(".error")')
        self.shot(page, 'login')
        page.type('#password', 'open sesame')
        page.evaluate('document.querySelector("form").requestSubmit()')
        self.wait_tiles(page, ALL_ITEMS, timeout=20)
        page.click('.topbar .icon-btn[aria-label="Lock Lurker in this browser"]')
        page.wait_for('location.pathname === "/login"')


class PhoneTests(BrowserTestCase):
    width, height, mobile = 390, 844, True

    def test_phone_layout(self):
        server = self.serve(directory=self.root)
        server.wait_ready()
        page = self.open_page(server.base + '/', scale=2)
        self.wait_tiles(page, ALL_ITEMS)
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'))
        position = page.evaluate('getComputedStyle(document.querySelector(".views")).position')
        self.assertEqual(position, 'fixed')  # the view switcher floats at the bottom
        grid_share = page.evaluate('document.querySelector("#view").getBoundingClientRect().height / innerHeight')
        self.assertGreater(grid_share, 0.7)
        page.click('.toolbar .icon-btn[aria-label="Filters"]')
        page.wait_for('getComputedStyle(document.querySelector(".filters")).position === "fixed"')
        self.shot(page, 'phone-filters')
        page.click('.filters footer .btn.primary')
        # The secondary actions live in a menu on phones.
        self.assertFalse(page.evaluate('Boolean(document.querySelector(".actions .optional").offsetParent)'))
        page.click('.actions .phone-only')
        page.wait_for('document.querySelector(".menu")')
        entries = page.evaluate('[...document.querySelectorAll(".menu button")].map(b => b.textContent)')
        self.assertIn('Rescan the directory', entries)
        page.key('Escape', 'Escape', 27)
        page.click('#view .tile')
        page.wait_for('document.querySelector(".viewer")')
        time.sleep(0.4)
        self.shot(page, 'phone-viewer')


if __name__ == '__main__':
    unittest.main()
