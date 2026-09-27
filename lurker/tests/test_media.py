"""Header readers: what each format yields, and that damaged files never crash."""
import os
import random
import shutil
import tempfile
import unittest

from tests.support import PROJECT_ROOT  # noqa: F401
from tests.support import fixtures as fx
from server.domain.previews import with_orientation
from server.media import exif, formats
from server.media.binary import BytesSource
from server.media.probe import probe, sniff
from server.media.readers import jpeg as jpeg_reader

WALL_2023_07_14_1030 = 1689330600  # 2023-07-14 10:30:00 as a wall-clock time


class ProbeCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix='lurker-media-')
        self.addCleanup(shutil.rmtree, self.directory, True)

    def probe(self, name, data, detail=False):
        path = os.path.join(self.directory, name)
        with open(path, 'wb') as handle:
            handle.write(data)
        return probe(path, formats.lookup(name), detail=detail)


class FormatTableTests(unittest.TestCase):
    def test_lookup_is_case_insensitive(self):
        self.assertEqual(formats.lookup('IMG_0001.JPG').key, 'jpeg')
        self.assertEqual(formats.lookup('clip.MOV').key, 'mov')
        self.assertEqual(formats.lookup('shot.CR2').key, 'raw')
        self.assertEqual(formats.lookup('photo.heic').kind, 'image')
        self.assertEqual(formats.lookup('movie.mkv').kind, 'video')

    def test_non_media_is_ignored(self):
        for name in ('notes.txt', 'archive.zip', 'README', 'Makefile', 'song.mp3', 'doc.pdf', 'trailing.'):
            self.assertIsNone(formats.lookup(name), name)

    def test_every_extension_belongs_to_one_format(self):
        seen = {}
        for fmt in formats.FORMATS:
            for extension in fmt.extensions:
                self.assertNotIn(extension, seen, 'duplicate extension %s' % extension)
                seen[extension] = fmt.key
            self.assertIn(fmt.kind, ('image', 'video'))
            self.assertIn(fmt.browser, ('yes', 'maybe', 'no'))

    def test_public_table(self):
        table = formats.public_table()
        self.assertEqual(len(table), len(formats.FORMATS))
        self.assertEqual(set(table[0]), {'key', 'label', 'kind', 'mime', 'browser', 'extensions'})


class JpegTests(ProbeCase):
    def test_size_orientation_camera_date_and_thumbnail(self):
        thumbnail = fx.jpeg(160, 120, color=(10, 200, 10))
        data = fx.jpeg(64, 48, exif=fx.exif_segment(orientation=6, make='Canon', model='Canon EOS R5',
                                                     taken='2023:07:14 10:30:00', thumbnail=thumbnail))
        result = self.probe('a.jpg', data)
        self.assertEqual((result['width'], result['height']), (64, 48))
        self.assertEqual(result['orientation'], 6)
        self.assertEqual((result['displayWidth'], result['displayHeight']), (48, 64))  # rotated 90 degrees
        self.assertEqual(result['camera'], 'Canon EOS R5')
        self.assertEqual(result['taken'], WALL_2023_07_14_1030)
        self.assertNotIn('takenUtc', result)  # EXIF times are wall-clock times
        start, length = result['preview']
        self.assertEqual(data[start:start + length], thumbnail)

    def test_little_endian_exif(self):
        data = fx.jpeg(32, 16, exif=fx.exif_segment(orientation=3, taken='2020:02:29 23:59:58', order='<'))
        result = self.probe('b.jpeg', data)
        self.assertEqual(result['orientation'], 3)
        self.assertEqual((result['displayWidth'], result['displayHeight']), (32, 16))
        self.assertEqual(result['taken'], 1583020798)

    def test_plain_jpeg(self):
        result = self.probe('c.jpg', fx.jpeg(100, 30))
        self.assertEqual((result['displayWidth'], result['displayHeight']), (100, 30))
        self.assertNotIn('orientation', result)
        self.assertNotIn('preview', result)

    def test_digitized_and_modified_dates_are_fallbacks(self):
        result = self.probe('d.jpg', fx.jpeg(8, 8, exif=fx.exif_segment(digitized='2019:01:01 00:00:00')))
        self.assertEqual(result['taken'], 1546300800)
        result = self.probe('e.jpg', fx.jpeg(8, 8, exif=fx.exif_segment(modified='2018:01:01 12:00:00')))
        self.assertEqual(result['taken'], 1514808000)

    def test_details_on_demand(self):
        data = fx.jpeg(8, 8, exif=fx.exif_segment(make='NIKON CORPORATION', model='NIKON D750', gps=(40.4168, -3.7038),
                                                   exposure={'time': (1, 250), 'f': (28, 10), 'iso': 400}))
        details = self.probe('f.jpg', data, detail=True)['details']
        self.assertEqual(details['make'], 'NIKON CORPORATION')
        self.assertEqual(details['iso'], 400)
        self.assertEqual(details['exposureTime'], [1, 250])
        self.assertEqual(details['fNumber'], [28, 10])
        self.assertAlmostEqual(details['latitude'], 40.4168, places=3)
        self.assertAlmostEqual(details['longitude'], -3.7038, places=3)
        self.assertNotIn('details', self.probe('g.jpg', data))

    def test_camera_names(self):
        self.assertEqual(exif.camera_name('Canon', 'Canon EOS 5D'), 'Canon EOS 5D')
        self.assertEqual(exif.camera_name('NIKON CORPORATION', 'NIKON D750'), 'NIKON D750')
        self.assertEqual(exif.camera_name('Apple', 'iPhone 15 Pro'), 'Apple iPhone 15 Pro')
        self.assertEqual(exif.camera_name('', 'X100V'), 'X100V')
        self.assertEqual(exif.camera_name('Sony', ''), 'Sony')
        self.assertIsNone(exif.camera_name(None, None))

    def test_bad_dates_are_ignored(self):
        for text in ('    :  :     :  :  ', '0000:00:00 00:00:00', '2021:13:01 00:00:00', 'yesterday', ''):
            self.assertIsNone(exif.parse_datetime(text), text)
        self.assertEqual(exif.parse_datetime('2021-06-01T08:00:00'), 1622534400)

    def test_orientation_is_injected_into_previews(self):
        thumbnail = fx.jpeg(16, 8)
        rotated = with_orientation(thumbnail, 8)
        self.assertEqual(rotated[:2], b'\xff\xd8')
        self.assertEqual(jpeg_reader.read(BytesSource(rotated))['orientation'], 8)
        self.assertEqual(with_orientation(thumbnail, 1), thumbnail)
        self.assertEqual(with_orientation(thumbnail, None), thumbnail)


class OtherImageTests(ProbeCase):
    def test_png(self):
        result = self.probe('a.png', fx.png(120, 45))
        self.assertEqual((result['displayWidth'], result['displayHeight']), (120, 45))
        self.assertNotIn('animated', result)
        self.assertTrue(self.probe('b.png', fx.png(10, 10, animated_frames=4))['animated'])
        with_exif = fx.png(10, 10, exif=fx.exif_tiff(taken='2023:07:14 10:30:00', orientation=6))
        result = self.probe('c.png', with_exif)
        self.assertEqual(result['taken'], WALL_2023_07_14_1030)
        self.assertNotIn('orientation', result)  # not applied to PNG by browsers

    def test_gif(self):
        still = self.probe('a.gif', fx.gif(33, 22, frames=1))
        self.assertEqual((still['width'], still['height']), (33, 22))
        self.assertNotIn('animated', still)
        self.assertTrue(self.probe('b.gif', fx.gif(8, 8, frames=3))['animated'])

    def test_webp_variants(self):
        self.assertEqual(self.probe('a.webp', fx.webp_vp8(300, 200))['displayWidth'], 300)
        lossless = self.probe('b.webp', fx.webp_vp8l(640, 480))
        self.assertEqual((lossless['width'], lossless['height']), (640, 480))
        extended = self.probe('c.webp', fx.webp_vp8x(4000, 3000, animated=True,
                                                     exif=fx.exif_tiff(taken='2023:07:14 10:30:00')))
        self.assertEqual((extended['width'], extended['height']), (4000, 3000))
        self.assertTrue(extended['animated'])
        self.assertEqual(extended['taken'], WALL_2023_07_14_1030)

    def test_bmp_ico_psd(self):
        self.assertEqual(self.probe('a.bmp', fx.bmp(40, 30))['displayHeight'], 30)
        top_down = bytearray(fx.bmp(40, 30))
        top_down[22:26] = (-30).to_bytes(4, 'little', signed=True)
        self.assertEqual(self.probe('b.bmp', bytes(top_down))['displayHeight'], 30)
        icon = b'\x00\x00\x01\x00\x02\x00' + bytes([16, 16]) + b'\x00' * 14 + bytes([0, 0]) + b'\x00' * 14
        self.assertEqual(self.probe('c.ico', icon)['width'], 256)  # 0 means 256
        psd = b'8BPS\x00\x01' + b'\x00' * 6 + b'\x00\x03' + (600).to_bytes(4, 'big') + (800).to_bytes(4, 'big') + b'\x00' * 4
        result = self.probe('d.psd', psd)
        self.assertEqual((result['width'], result['height']), (800, 600))

    def test_svg(self):
        sized = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="120px" height="80">'
        self.assertEqual(self.probe('a.svg', sized)['displayWidth'], 120)
        boxed = b"<svg viewBox='0 0 24 12' xmlns='http://www.w3.org/2000/svg'><path/></svg>"
        result = self.probe('b.svg', boxed)
        self.assertEqual((result['width'], result['height']), (24, 12))
        relative = b'<svg width="100%" height="100%" viewBox="0,0,300,150"></svg>'
        self.assertEqual(self.probe('c.svg', relative)['width'], 300)

    def test_camera_raw_uses_the_largest_embedded_jpeg(self):
        preview = fx.jpeg(120, 80) + b'\x00' * 4000
        data = fx.raw_file(preview, thumbnail=fx.jpeg(16, 16) + b'\x00' * 2100, orientation=8,
                           taken='2022:05:02 09:15:00', width=6000, height=4000)
        result = self.probe('IMG.CR2', data)
        start, length = result['preview']
        self.assertEqual(data[start:start + length], preview)
        self.assertEqual((result['width'], result['height']), (6000, 4000))
        self.assertEqual((result['displayWidth'], result['displayHeight']), (4000, 6000))
        self.assertEqual(result['camera'], 'Canon EOS 5D')
        self.assertEqual(result['taken'], 1651482900)

    def test_fujifilm_raf(self):
        embedded = fx.jpeg(90, 60, exif=fx.exif_segment(make='FUJIFILM', model='X-T3', orientation=1,
                                                         taken='2021:10:10 10:10:10'))
        data = fx.raf_file(embedded)
        result = self.probe('DSCF0001.RAF', data)
        start, length = result['preview']
        self.assertEqual(data[start:start + length], embedded)
        self.assertEqual(result['camera'], 'FUJIFILM X-T3')
        self.assertEqual((result['width'], result['height']), (90, 60))

    def test_heif_primary_item_rotation_and_exif(self):
        data = fx.heif(4032, 3024, rotation_ccw=90, exif_tiff_bytes=fx.exif_tiff(make='Apple', model='iPhone 15',
                                                                               taken='2023:07:14 10:30:00'))
        result = self.probe('IMG_1234.HEIC', data)
        self.assertEqual((result['width'], result['height']), (4032, 3024))  # not the 512x512 tile
        self.assertEqual(result['rotation'], 270)
        self.assertEqual((result['displayWidth'], result['displayHeight']), (3024, 4032))
        self.assertEqual(result['taken'], WALL_2023_07_14_1030)
        self.assertEqual(result['camera'], 'Apple iPhone 15')

    def test_avif(self):
        result = self.probe('a.avif', fx.heif(1200, 800, brand=b'avif'))
        self.assertEqual((result['displayWidth'], result['displayHeight']), (1200, 800))


class VideoTests(ProbeCase):
    def test_mp4(self):
        result = self.probe('a.mp4', fx.mp4(1920, 1080, duration=12.5, created=1609459200))
        self.assertEqual((result['width'], result['height']), (1920, 1080))
        self.assertAlmostEqual(result['duration'], 12.5)
        self.assertEqual(result['taken'], 1609459200)
        self.assertTrue(result['takenUtc'])
        self.assertEqual(result['codec'], 'avc1')
        self.assertNotIn('rotation', result)

    def test_rotation_swaps_the_display_size(self):
        for degrees in (90, 270):
            result = self.probe('r%d.mp4' % degrees, fx.mp4(1920, 1080, rotation=degrees))
            self.assertEqual(result['rotation'], degrees)
            self.assertEqual((result['displayWidth'], result['displayHeight']), (1080, 1920))
        upside_down = self.probe('r180.mov', fx.mp4(1280, 720, rotation=180, brand=b'qt  '))
        self.assertEqual((upside_down['displayWidth'], upside_down['displayHeight']), (1280, 720))

    def test_64_bit_movie_header_and_hevc(self):
        result = self.probe('b.mov', fx.mp4(3840, 2160, duration=3.25, version=1, codec=b'hvc1', brand=b'qt  '))
        self.assertAlmostEqual(result['duration'], 3.25)
        self.assertEqual(result['codec'], 'hvc1')

    def test_fragmented_mp4_duration(self):
        result = self.probe('c.mp4', fx.mp4(1280, 720, fragmented=True, audio=False))
        self.assertAlmostEqual(result['duration'], (450000 + 25 * 3000) / 90000, places=3)

    def test_unset_creation_time_is_ignored(self):
        self.assertNotIn('taken', self.probe('d.mp4', fx.mp4(created=None)))

    def test_matroska_and_webm(self):
        result = self.probe('a.mkv', fx.matroska(1280, 720, 8000.0, codec='V_MPEG4/ISO/AVC', doctype='matroska',
                                                 date_ns=int((1609459200 - 978307200) * 1e9)))
        self.assertEqual((result['width'], result['height']), (1280, 720))
        self.assertAlmostEqual(result['duration'], 8.0)
        self.assertEqual(result['codec'], 'h264')
        self.assertEqual(result['taken'], 1609459200)
        self.assertTrue(result['takenUtc'])
        webm = self.probe('b.webm', fx.matroska(640, 360, 2500.0, codec='V_VP9'))
        self.assertEqual(webm['codec'], 'vp9')
        self.assertAlmostEqual(webm['duration'], 2.5)

    def test_matroska_headers_after_the_first_cluster(self):
        result = self.probe('c.mkv', fx.matroska(800, 600, 1234.0, tracks_after_cluster=True))
        self.assertEqual((result['width'], result['height']), (800, 600))
        self.assertAlmostEqual(result['duration'], 1.234)

    def test_real_webm_fixture(self):
        result = self.probe('tiny.webm', fx.TINY_WEBM)
        self.assertEqual((result['width'], result['height'], result['codec']), (64, 48, 'vp8'))
        self.assertAlmostEqual(result['duration'], 1.5)

    def test_avi(self):
        result = self.probe('a.avi', fx.avi(640, 480, frames=250, fps=25))
        self.assertEqual((result['width'], result['height']), (640, 480))
        self.assertAlmostEqual(result['duration'], 10.0)
        self.assertEqual(result['codec'], 'xvid')
        big = self.probe('b.avi', fx.avi(1280, 720, frames=100, fps=25, odml_frames=90000))
        self.assertAlmostEqual(big['duration'], 3600.0)

    def test_transport_stream_sniffing(self):
        self.assertEqual(sniff(fx.transport_stream(3)), 'mpegts')
        self.assertEqual(sniff(fx.transport_stream(3, packet_size=192)), 'mpegts')
        self.assertIsNone(sniff(b'export const x = 1;\n' * 30))


class SniffingTests(ProbeCase):
    def test_content_wins_over_the_extension(self):
        result = self.probe('actually-a-png.jpg', fx.png(77, 33))
        self.assertEqual((result['width'], result['height']), (77, 33))
        result = self.probe('actually-a-jpeg.png', fx.jpeg(21, 13))
        self.assertEqual((result['width'], result['height']), (21, 13))

    def test_unknown_content_gives_no_metadata(self):
        self.assertEqual(self.probe('empty.jpg', b''), {})
        self.assertEqual(self.probe('text.mp4', b'hello world, not a movie'), {})


class RobustnessTests(ProbeCase):
    """Truncated and corrupted files must yield partial metadata, never an exception."""

    SAMPLES = {
        'a.jpg': lambda: fx.jpeg(64, 48, exif=fx.exif_segment(orientation=6, make='X', model='Y', taken='2020:01:01 00:00:00',
                                                               thumbnail=fx.jpeg(16, 16), gps=(1.5, 2.5))),
        'a.png': lambda: fx.png(20, 20, animated_frames=2, exif=fx.exif_tiff(taken='2020:01:01 00:00:00')),
        'a.gif': lambda: fx.gif(10, 10, frames=2),
        'a.webp': lambda: fx.webp_vp8x(100, 100, animated=True, exif=fx.exif_tiff(taken='2020:01:01 00:00:00')),
        'a.bmp': lambda: fx.bmp(4, 4),
        'a.mp4': lambda: fx.mp4(fragmented=True),
        'b.mp4': lambda: fx.mp4(version=1, rotation=90, created=1609459200),
        'a.heic': lambda: fx.heif(exif_tiff_bytes=fx.exif_tiff(taken='2020:01:01 00:00:00'), rotation_ccw=90),
        'a.mkv': lambda: fx.matroska(tracks_after_cluster=True, date_ns=1),
        'a.avi': lambda: fx.avi(odml_frames=10),
        'a.cr2': lambda: fx.raw_file(fx.jpeg(8, 8) + b'\x00' * 3000, thumbnail=fx.jpeg(8, 8)),
        'a.raf': lambda: fx.raf_file(fx.jpeg(8, 8)),
    }

    def test_every_truncation(self):
        for name, build in self.SAMPLES.items():
            data = build()
            step = max(1, len(data) // 150)
            for cut in range(0, len(data), step):
                with self.subTest(file=name, cut=cut):
                    self.assertIsInstance(self.probe(name, data[:cut]), dict)

    def test_random_corruption(self):
        chaos = random.Random(1234)
        for name, build in self.SAMPLES.items():
            original = build()
            for round_ in range(60):
                data = bytearray(original)
                for _ in range(chaos.randint(1, 12)):
                    data[chaos.randrange(len(data))] = chaos.randrange(256)
                with self.subTest(file=name, round=round_):
                    self.assertIsInstance(self.probe(name, bytes(data)), dict)

    def test_random_garbage_with_valid_magic(self):
        chaos = random.Random(99)
        magics = [b'\xff\xd8\xff', b'\x89PNG\r\n\x1a\n', b'RIFF\x00\x00\x00\x00WEBPVP8X', b'\x1a\x45\xdf\xa3',
                  b'\x00\x00\x00\x18ftypheic', b'II*\x00', b'MM\x00*', b'RIFF\x00\x00\x00\x00AVI ', b'GIF89a']
        for index in range(300):
            data = chaos.choice(magics) + bytes(chaos.randrange(256) for _ in range(chaos.randint(0, 600)))
            with self.subTest(index=index):
                self.assertIsInstance(self.probe('g%d.bin.jpg' % index, data), dict)


if __name__ == '__main__':
    unittest.main()
