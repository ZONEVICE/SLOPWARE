"""Command-line options: bare words as the specification writes them, and dashes."""
import os
import unittest

from tests.support import PROJECT_ROOT  # noqa: F401
from server.config import DEFAULT_PORT, UsageError, parse_args


class DefaultsTests(unittest.TestCase):
    def test_https_on_8080_by_default(self):
        config = parse_args([])
        self.assertEqual(config.protocol, 'https')
        self.assertTrue(config.https)
        self.assertEqual(config.port, DEFAULT_PORT)
        self.assertEqual(DEFAULT_PORT, 8080)
        self.assertEqual(config.host, '0.0.0.0')
        self.assertIsNone(config.directory)
        self.assertIsNone(config.password)

    def test_certificate_lives_in_the_application_directory(self):
        config = parse_args([])
        self.assertEqual(config.cert_dir, os.path.join(PROJECT_ROOT, 'cert'))


class BareWordTests(unittest.TestCase):
    def test_every_option_as_a_word(self):
        config = parse_args(['http', 'port', '9000', 'dir', '/srv/photos', 'pass', 's3cret'])
        self.assertEqual(config.protocol, 'http')
        self.assertEqual(config.port, 9000)
        self.assertEqual(config.directory, os.path.normpath('/srv/photos'))
        self.assertEqual(config.password, 's3cret')

    def test_https_word(self):
        self.assertEqual(parse_args(['https']).protocol, 'https')

    def test_words_are_case_insensitive(self):
        config = parse_args(['HTTP', 'Port', '81'])
        self.assertEqual((config.protocol, config.port), ('http', 81))

    def test_a_value_is_taken_verbatim_even_if_it_looks_like_an_option(self):
        self.assertEqual(parse_args(['pass', 'port']).password, 'port')
        self.assertEqual(parse_args(['pass', '--https']).password, '--https')
        self.assertEqual(parse_args(['pass', 'a=b c']).password, 'a=b c')


class DashedTests(unittest.TestCase):
    def test_dashed_forms(self):
        config = parse_args(['--http', '--port', '9001', '--dir', '/tmp', '--pass', 'x', '--verbose'])
        self.assertEqual((config.protocol, config.port, config.password, config.verbose), ('http', 9001, 'x', True))

    def test_equals_form(self):
        config = parse_args(['--port=9002', '--pass=with=equals', '--dir=/var'])
        self.assertEqual(config.port, 9002)
        self.assertEqual(config.password, 'with=equals')
        self.assertEqual(config.directory, os.path.normpath('/var'))

    def test_help_and_version(self):
        self.assertTrue(parse_args(['help']).show_help)
        self.assertTrue(parse_args(['--help']).show_help)
        self.assertTrue(parse_args(['-h']).show_help)
        self.assertTrue(parse_args(['version']).show_version)


class PathTests(unittest.TestCase):
    def test_relative_directory_is_resolved_against_the_working_directory(self):
        config = parse_args(['dir', 'photos/2024'], cwd='/home/someone')
        self.assertEqual(config.directory, os.path.normpath('/home/someone/photos/2024'))

    def test_home_is_expanded(self):
        config = parse_args(['dir', '~'])
        self.assertEqual(config.directory, os.path.normpath(os.path.expanduser('~')))


class ErrorTests(unittest.TestCase):
    def assertUsage(self, argv, fragment):
        with self.assertRaises(UsageError) as caught:
            parse_args(argv)
        self.assertIn(fragment, str(caught.exception))

    def test_missing_value(self):
        self.assertUsage(['port'], 'needs a value')
        self.assertUsage(['pass'], 'needs a value')

    def test_bad_port(self):
        self.assertUsage(['port', 'abc'], 'must be a number')
        self.assertUsage(['port', '70000'], 'between 0 and 65535')
        self.assertUsage(['port', '-1'], 'between 0 and 65535')

    def test_port_zero_is_allowed(self):
        self.assertEqual(parse_args(['port', '0']).port, 0)

    def test_both_protocols(self):
        self.assertUsage(['http', 'https'], 'either http or https')

    def test_unknown_word(self):
        self.assertUsage(['fast'], 'Unknown option "fast"')

    def test_a_bare_path_suggests_dir(self):
        self.assertUsage(['/home/me/Pictures'], 'dir /home/me/Pictures')

    def test_empty_password(self):
        self.assertUsage(['pass', ''], 'cannot be empty')

    def test_flag_with_value(self):
        self.assertUsage(['--https=yes'], 'does not take a value')


if __name__ == '__main__':
    unittest.main()
