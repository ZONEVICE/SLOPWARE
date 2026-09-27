"""The album: path checks, the recursive scan, the catalog's revisions, rescans."""
import os
import shutil
import stat
import tempfile
import threading
import time
import unittest

from tests.support import PROJECT_ROOT  # noqa: F401
from tests.support import fixtures as fx
from server.domain import paths, scanner
from server.domain.album import AlbumService
from server.domain.catalog import Catalog
from server.domain.errors import AppError
from server.lib import events
from server.lib.events import EventBus

EXPECTED = {
    'beach.jpg', 'sunset.png', 'spinner.gif', 'clip.webm', 'trips/2022/paris.jpg', 'trips/2022/louvre.bmp',
    'trips/2022/raw/IMG_0001.CR2', '.hidden/secret.jpg', 'videos/movie.mp4', 'videos/phone.mkv', 'videos/old.avi',
    'videos/stream.ts',
}


def relative(catalog, item):
    return (item.folder.rel + '/' if item.folder.rel else '') + item.name


def live_items(catalog):
    return {relative(catalog, item): item for item in catalog.items if item.alive}


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='lurker-album-')
        self.addCleanup(shutil.rmtree, self.root, True)


class PathCheckTests(TempDirCase):
    def test_accepts_a_readable_directory(self):
        check = paths.check_directory(self.root)
        self.assertTrue(check.ok)
        self.assertEqual(check.path, os.path.normpath(self.root))
        self.assertEqual(check.real, os.path.realpath(self.root))
        self.assertEqual(check.name, os.path.basename(self.root))

    def test_rejections(self):
        file_path = os.path.join(self.root, 'file.txt')
        with open(file_path, 'w') as handle:
            handle.write('x')
        cases = {
            '': 'empty',
            '   ': 'empty',
            'relative/path': 'not_absolute',
            os.path.join(self.root, 'missing'): 'not_found',
            file_path: 'not_directory',
            '/tmp/\x00bad': 'invalid',
        }
        for raw, code in cases.items():
            with self.subTest(raw=raw):
                check = paths.check_directory(raw)
                self.assertFalse(check.ok)
                self.assertEqual(check.code, code)
                self.assertTrue(check.message)

    @unittest.skipIf(os.name == 'nt' or os.geteuid() == 0, 'permissions are not enforced here')
    def test_unreadable_directory(self):
        locked = os.path.join(self.root, 'locked')
        os.mkdir(locked)
        os.chmod(locked, 0)
        self.addCleanup(os.chmod, locked, stat.S_IRWXU)
        check = paths.check_directory(locked)
        self.assertFalse(check.ok)
        self.assertEqual(check.code, 'not_readable')

    def test_home_and_whitespace(self):
        self.assertTrue(paths.check_directory('~').ok)
        self.assertTrue(paths.check_directory('  %s  ' % self.root).ok)

    def test_suggestions(self):
        for name in ('Photos', 'photos-old', 'Pictures', '.private', 'notes'):
            os.mkdir(os.path.join(self.root, name))
        with open(os.path.join(self.root, 'photo.jpg'), 'w'):
            pass
        found = paths.suggest(os.path.join(self.root, 'pho'))
        self.assertEqual([os.path.basename(path) for path in found], ['Photos', 'photos-old'])
        everything = [os.path.basename(path) for path in paths.suggest(self.root + os.sep)]
        self.assertEqual(everything, ['notes', 'Photos', 'photos-old', 'Pictures'])
        self.assertEqual([os.path.basename(p) for p in paths.suggest(os.path.join(self.root, '.pr'))], ['.private'])
        self.assertEqual(paths.suggest('relative'), [])
        self.assertEqual(paths.suggest(os.path.join(self.root, 'missing', 'x')), [])

    def test_shortcuts_start_with_home(self):
        shortcuts = paths.shortcuts()
        self.assertEqual(shortcuts[0], {'label': 'Home', 'path': os.path.expanduser('~')})
        for entry in shortcuts:
            self.assertTrue(os.path.isdir(entry['path']))


class ScanTests(TempDirCase):
    def scan(self):
        catalog = Catalog('test', os.path.realpath(self.root))
        stats = scanner.ScanStats()
        probed = []
        finished = scanner.walk(catalog, stats, lambda: False, probed.extend)
        self.assertTrue(finished)
        catalog.commit()
        return catalog, stats, probed

    def test_finds_every_image_and_video_below_the_root(self):
        fx.make_album(self.root)
        catalog, stats, probed = self.scan()
        found = live_items(catalog)
        self.assertEqual(set(found), EXPECTED)
        self.assertEqual({relative(catalog, item) for item in probed}, EXPECTED)
        summary = catalog.summary()
        self.assertEqual((summary['items'], summary['images'], summary['videos']), (12, 7, 5))
        self.assertEqual(summary['bytes'], sum(os.path.getsize(os.path.join(self.root, *rel.split('/'))) for rel in EXPECTED))
        self.assertEqual(stats.skipped, 0)

    def test_ignores_symlinks_typescript_and_other_files(self):
        fx.make_album(self.root)
        catalog, _, _ = self.scan()
        names = set(live_items(catalog))
        for ignored in ('link.jpg', 'trips/2022/notes.txt', 'code/app.ts', 'code/types.d.ts'):
            self.assertNotIn(ignored, names)
        self.assertFalse(any(name.startswith('trips-link') for name in names))

    def test_folders_appear_only_when_they_hold_media(self):
        fx.make_album(self.root)
        catalog, _, _ = self.scan()
        folders = {folder.rel for folder in catalog.folders if folder.alive}
        self.assertEqual(folders, {'', '.hidden', 'trips', 'trips/2022', 'trips/2022/raw', 'videos'})

    def test_hidden_items(self):
        fx.make_album(self.root)
        catalog, _, _ = self.scan()
        found = live_items(catalog)
        self.assertTrue(found['.hidden/secret.jpg'].hidden)
        self.assertFalse(found['beach.jpg'].hidden)
        fx.write(os.path.join(self.root, '.dotfile.png'), fx.png(4, 4))
        catalog, _, _ = self.scan()
        self.assertTrue(live_items(catalog)['.dotfile.png'].hidden)

    def test_ids_follow_name_order(self):
        for name in ('c.jpg', 'a.jpg', 'b.jpg'):
            fx.write(os.path.join(self.root, name), fx.jpeg(8, 8))
        catalog, _, _ = self.scan()
        self.assertEqual([item.name for item in catalog.items], ['a.jpg', 'b.jpg', 'c.jpg'])

    def test_a_real_transport_stream_counts_as_video(self):
        fx.write(os.path.join(self.root, 'recording.mts'), fx.transport_stream(20, 192))
        fx.write(os.path.join(self.root, 'module.mts'), b'export default 1;\n' * 100)
        catalog, _, _ = self.scan()
        self.assertEqual(set(live_items(catalog)), {'recording.mts'})

    @unittest.skipIf(os.name == 'nt' or os.geteuid() == 0, 'permissions are not enforced here')
    def test_unreadable_folders_are_reported_not_fatal(self):
        fx.make_album(self.root)
        locked = os.path.join(self.root, 'videos')
        os.chmod(locked, 0)
        self.addCleanup(os.chmod, locked, stat.S_IRWXU)
        catalog, stats, _ = self.scan()
        self.assertEqual(stats.skipped, 1)
        self.assertEqual(stats.errors[0]['path'], 'videos')
        self.assertFalse(any(name.startswith('videos/') for name in live_items(catalog)))
        self.assertIn('beach.jpg', live_items(catalog))

    def test_cancellation(self):
        fx.make_album(self.root)
        catalog = Catalog('test', os.path.realpath(self.root))
        self.assertFalse(scanner.walk(catalog, scanner.ScanStats(), lambda: True, lambda items: None))


class CatalogRevisionTests(TempDirCase):
    def test_full_and_incremental_deltas(self):
        fx.make_album(self.root)
        catalog = Catalog('test', os.path.realpath(self.root))
        scanner.walk(catalog, scanner.ScanStats(), lambda: False, lambda items: None)
        catalog.commit()
        full = catalog.delta(0)
        self.assertTrue(full['full'])
        self.assertEqual(len(full['items']), 12)
        rev = full['rev']
        self.assertEqual(catalog.delta(rev)['items'], [])

        beach = live_items(catalog)['beach.jpg']
        self.assertTrue(catalog.apply_probe(beach.id, beach.version, {'displayWidth': 48, 'displayHeight': 64,
                                                                      'orientation': 6, 'taken': 1689330600}, 1700000000))
        self.assertFalse(catalog.apply_probe(beach.id, 'stale-version', {}, None))
        catalog.commit()
        delta = catalog.delta(rev)
        self.assertFalse(delta['full'])
        self.assertEqual([entry['n'] for entry in delta['items']], ['beach.jpg'])
        wire = delta['items'][0]
        self.assertEqual((wire['w'], wire['h'], wire['o'], wire['t'], wire['b'], wire['p']), (48, 64, 6, 1689330600, 1700000000, 1))
        self.assertGreater(delta['rev'], rev)

    def test_a_revision_from_the_future_gets_everything(self):
        catalog = Catalog('test', self.root)
        self.assertTrue(catalog.delta(999)['full'])

    def test_wire_names_are_always_text(self):
        catalog = Catalog('test', self.root)
        folder = catalog.ensure_folder(['bad\udcff'], [False])
        catalog.sync_folder(folder, [('photo\udce9.jpg', fx_format('a.jpg'), 10, 0, False)])
        wire = catalog.delta(0)
        self.assertEqual(wire['items'][0]['n'], 'photo�.jpg')
        self.assertIn('bad�', [entry['n'] for entry in wire['folders']])


def fx_format(name):
    from server.media import formats
    return formats.lookup(name)


class AlbumServiceTests(TempDirCase):
    def setUp(self):
        super().setUp()
        self.bus = EventBus()
        self.events = []
        for name in (events.ALBUM_OPENED, events.ALBUM_CLOSED, events.SCAN_FINISHED, events.PROBE_FINISHED):
            self.bus.subscribe(name, lambda payload, name=name: self.events.append((name, payload)))
        self.album = AlbumService(self.bus, probe_workers=2, commit_interval=0.05)
        self.addCleanup(self.album.shutdown)

    def wait_until(self, predicate, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return
            time.sleep(0.02)
        self.fail('condition not reached; status: %r' % self.album.status())

    def ready(self):
        status = self.album.status()
        return status['status'] == 'ready' and status['probe']['done'] >= status['probe']['total'] and any(
            name == events.PROBE_FINISHED for name, _ in self.events)

    def test_open_scan_probe_close(self):
        fx.make_album(self.root)
        status = self.album.open(self.root)
        self.assertIn(status['status'], ('scanning', 'ready'))
        self.assertEqual(status['root'], os.path.normpath(self.root))
        self.wait_until(self.ready)
        status = self.album.status()
        self.assertEqual(status['counts']['items'], 12)
        self.assertEqual(status['counts']['probed'], 12)
        self.assertEqual(status['scan']['skipped'], 0)
        names = [name for name, _ in self.events]
        self.assertEqual(names[:2], [events.ALBUM_OPENED, events.SCAN_FINISHED])
        self.assertIn(events.PROBE_FINISHED, names)

        item, path = self.album.resolve(status['id'], 0)
        self.assertTrue(os.path.isfile(path))
        details = self.album.details(status['id'], live_items(self.album.session.catalog)['beach.jpg'].id)
        self.assertEqual(details['details']['model'], 'Canon EOS R5')
        self.assertEqual(details['orientation'], 6)
        self.assertEqual((details['width'], details['height']), (48, 64))

        closed = self.album.close()
        self.assertEqual(closed['status'], 'empty')
        self.assertEqual(closed['recent'][0]['path'], os.path.normpath(self.root))
        with self.assertRaises(AppError) as caught:
            self.album.resolve(status['id'], 0)
        self.assertEqual((caught.exception.status, caught.exception.code), (404, 'no_album'))
        self.assertEqual(self.events[-1][0], events.ALBUM_CLOSED)

    def test_one_album_at_a_time(self):
        self.album.open(self.root)
        other = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, other, True)
        with self.assertRaises(AppError) as caught:
            self.album.open(other)
        self.assertEqual((caught.exception.status, caught.exception.code), (409, 'album_open'))

    def test_invalid_paths_are_refused_before_scanning(self):
        for raw, code in (('not/absolute', 'not_absolute'), (os.path.join(self.root, 'nope'), 'not_found')):
            with self.assertRaises(AppError) as caught:
                self.album.open(raw)
            self.assertEqual((caught.exception.status, caught.exception.code), (400, code))
        self.assertEqual(self.album.status()['status'], 'empty')

    def test_command_line_directory(self):
        check = self.album.open_initial(os.path.join(self.root, 'missing'))
        self.assertFalse(check.ok)
        notice = self.album.status()['notice']
        self.assertEqual(notice['code'], 'not_found')
        self.assertTrue(self.album.open_initial(self.root).ok)
        self.assertNotEqual(self.album.status()['status'], 'empty')
        self.assertNotIn('notice', self.album.status())

    def test_stale_album_ids_are_refused(self):
        status = self.album.open(self.root)
        with self.assertRaises(AppError) as caught:
            self.album.delta('someothers', 0)
        self.assertEqual((caught.exception.status, caught.exception.code), (409, 'album_changed'))
        self.assertEqual(self.album.delta(status['id'], 0)['album'], status['id'])

    def test_rescan_adds_updates_and_removes(self):
        fx.make_album(self.root)
        status = self.album.open(self.root)
        self.wait_until(self.ready)
        catalog = self.album.session.catalog
        # Items are updated in place, so remember the values, not the objects.
        before = {name: (item.id, item.version, item.folder.id) for name, item in live_items(catalog).items()}
        rev = catalog.rev
        # Change the tree: one new file, one modified, one deleted, one folder gone.
        fx.write(os.path.join(self.root, 'new', 'fresh.png'), fx.png(5, 5))
        fx.write(os.path.join(self.root, 'sunset.png'), fx.png(200, 100), mtime=1700000500)
        os.remove(os.path.join(self.root, 'spinner.gif'))
        shutil.rmtree(os.path.join(self.root, 'videos'))
        self.events.clear()
        self.album.rescan(status['id'])
        with self.assertRaises(AppError):
            self.album.rescan(status['id'])  # already scanning
        self.wait_until(self.ready)
        after = live_items(catalog)
        self.assertIn('new/fresh.png', after)
        self.assertNotIn('spinner.gif', after)
        self.assertFalse(any(name.startswith('videos/') for name in after))
        self.assertEqual(after['beach.jpg'].id, before['beach.jpg'][0])          # unchanged: same ID
        self.assertEqual(after['beach.jpg'].version, before['beach.jpg'][1])
        self.assertEqual(after['sunset.png'].id, before['sunset.png'][0])        # changed: same ID...
        self.assertNotEqual(after['sunset.png'].version, before['sunset.png'][1])  # ...new version
        self.assertEqual(after['sunset.png'].width, 200)                          # and probed again
        delta = self.album.delta(status['id'], rev)
        changed = {entry['n'] for entry in delta['items']}
        self.assertEqual(changed, {'fresh.png', 'sunset.png'})
        self.assertEqual(set(delta['removedItems']),
                         {before[name][0] for name in before if name == 'spinner.gif' or name.startswith('videos/')})
        self.assertIn(before['videos/movie.mp4'][2], delta['removedFolders'])
        self.assertTrue(any(name == events.SCAN_FINISHED and payload['rescan'] for name, payload in self.events))

    def test_close_while_scanning_stops_the_work(self):
        for index in range(300):
            fx.write(os.path.join(self.root, 'd%03d' % (index // 10), 'f%03d.png' % index), fx.png(2, 2))
        self.album.open(self.root)
        session = self.album.session
        self.album.close()
        self.assertTrue(session.cancel.is_set())
        time.sleep(0.3)
        self.assertEqual(self.album.status()['status'], 'empty')

    def test_concurrent_readers_during_a_scan(self):
        for index in range(400):
            fx.write(os.path.join(self.root, 'd%02d' % (index // 20), 'f%03d.png' % index), fx.png(3, 3))
        status = self.album.open(self.root)
        errors = []

        def reader():
            try:
                since = 0
                for _ in range(200):
                    delta = self.album.delta(status['id'], since)
                    since = delta['rev']
                    self.album.status()
            except Exception as error:  # pragma: no cover - reported below
                errors.append(error)

        threads = [threading.Thread(target=reader) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(30)
        self.assertEqual(errors, [])
        self.wait_until(self.ready)
        self.assertEqual(self.album.status()['counts']['items'], 400)


if __name__ == '__main__':
    unittest.main()
