"""The readers against files written by real tools (ffmpeg, ImageMagick), when installed.

The hand-built fixtures prove the parsing logic; these prove it matches what
real encoders write. Each test skips itself when its tool is missing.
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

from tests.support import PROJECT_ROOT  # noqa: F401
from server.media import formats
from server.media.probe import probe

FFMPEG = shutil.which('ffmpeg')
FFPROBE = shutil.which('ffprobe')
CONVERT = shutil.which('convert') or shutil.which('magick')


@unittest.skipUnless(FFMPEG and FFPROBE, 'ffmpeg/ffprobe not installed')
class FfmpegVideoTests(unittest.TestCase):
    CASES = [
        ('h264.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], 2.0, (320, 240)),
        ('h264.mov', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], 1.6, (426, 240)),
        ('vp8.webm', ['-c:v', 'libvpx', '-b:v', '100k'], 1.2, (256, 144)),
        ('h264.mkv', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], 2.4, (320, 180)),
        ('mpeg4.avi', ['-c:v', 'mpeg4'], 2.0, (352, 288)),
        ('fragmented.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov'],
         2.0, (320, 240)),
    ]

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix='lurker-ffmpeg-')
        cls.made = {}
        for name, codec, seconds, (width, height) in cls.CASES:
            path = os.path.join(cls.directory, name)
            done = subprocess.run(
                [FFMPEG, '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=%dx%d:rate=25' % (width, height),
                 '-t', str(seconds)] + codec + [path], capture_output=True)
            if done.returncode == 0:
                cls.made[name] = path

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.directory, ignore_errors=True)

    def ffprobe(self, path):
        output = subprocess.run([FFPROBE, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
                                capture_output=True, text=True, check=True).stdout
        data = json.loads(output)
        video = next(stream for stream in data['streams'] if stream['codec_type'] == 'video')
        return float(data['format']['duration']), video['width'], video['height']

    def test_duration_and_size_match_ffprobe(self):
        if not self.made:
            self.skipTest('ffmpeg could not encode any sample')
        for name, path in self.made.items():
            with self.subTest(file=name):
                result = probe(path, formats.lookup(name))
                duration, width, height = self.ffprobe(path)
                self.assertEqual((result.get('width'), result.get('height')), (width, height))
                self.assertAlmostEqual(result.get('duration', 0), duration, delta=0.15)

    def test_rotation_metadata(self):
        source = self.made.get('h264.mp4')
        if not source:
            self.skipTest('no H.264 sample')
        rotated = os.path.join(self.directory, 'rotated.mp4')
        subprocess.run([FFMPEG, '-v', 'error', '-y', '-i', source, '-c', 'copy', '-metadata:s:v:0', 'rotate=90', rotated],
                       check=True, capture_output=True)
        result = probe(rotated, formats.lookup('rotated.mp4'))
        self.assertIn(result.get('rotation'), (90, 270))
        self.assertEqual((result['displayWidth'], result['displayHeight']), (240, 320))


@unittest.skipUnless(CONVERT, 'ImageMagick not installed')
class ImageMagickTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix='lurker-magick-')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.directory, ignore_errors=True)

    def make(self, name, *arguments):
        path = os.path.join(self.directory, name)
        done = subprocess.run([CONVERT, '-size', '301x199', 'xc:orange'] + list(arguments) + [path], capture_output=True)
        if done.returncode != 0:
            self.skipTest('ImageMagick cannot write %s' % name)
        return path

    def test_common_formats(self):
        for name in ('a.jpg', 'a.png', 'a.gif', 'a.bmp', 'a.tiff', 'a.webp', 'a.ico', 'a.psd'):
            with self.subTest(file=name):
                path = self.make(name) if name != 'a.ico' else self.make(name, '-resize', '64x42!')
                result = probe(path, formats.lookup(name))
                expected = (64, 42) if name == 'a.ico' else (301, 199)
                self.assertEqual((result.get('displayWidth'), result.get('displayHeight')), expected)

    def test_heic_and_avif(self):
        for name in ('a.heic', 'a.avif'):
            with self.subTest(file=name):
                path = self.make(name)
                result = probe(path, formats.lookup(name))
                self.assertEqual((result.get('width'), result.get('height')), (301, 199))


if __name__ == '__main__':
    unittest.main()
