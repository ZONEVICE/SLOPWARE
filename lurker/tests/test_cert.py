"""The self-signed certificate, built in pure Python: ASN.1, RSA, X.509, files, TLS."""
import datetime
import hashlib
import os
import shutil
import socket
import ssl
import stat
import subprocess
import tempfile
import unittest

from tests.support import PROJECT_ROOT  # noqa: F401
from tests.support.server import RunningLurker
from server.lib import asn1, cert, rsa, x509

OPENSSL = shutil.which('openssl')


class Asn1Tests(unittest.TestCase):
    def test_integers_are_minimal_and_positive(self):
        self.assertEqual(asn1.integer(0), b'\x02\x01\x00')
        self.assertEqual(asn1.integer(127), b'\x02\x01\x7f')
        self.assertEqual(asn1.integer(128), b'\x02\x02\x00\x80')
        self.assertEqual(asn1.integer(256), b'\x02\x02\x01\x00')

    def test_long_lengths(self):
        encoded = asn1.octet_string(b'x' * 300)
        self.assertEqual(encoded[:4], b'\x04\x82\x01\x2c')

    def test_object_identifiers(self):
        self.assertEqual(asn1.oid('2.5.4.3'), b'\x06\x03\x55\x04\x03')
        self.assertEqual(asn1.oid('1.2.840.113549.1.1.11'), bytes.fromhex('06092a864886f70d01010b'))

    def test_times_switch_to_generalized_after_2049(self):
        utc = datetime.timezone.utc
        self.assertEqual(asn1.time(datetime.datetime(2030, 1, 2, 3, 4, 5, tzinfo=utc)), b'\x17\x0d300102030405Z')
        self.assertEqual(asn1.time(datetime.datetime(2050, 1, 2, 3, 4, 5, tzinfo=utc))[:2], b'\x18\x0f')


class RsaTests(unittest.TestCase):
    def test_primality(self):
        for prime in (2, 3, 5, 7919, 104729, 2 ** 61 - 1):
            self.assertTrue(rsa.is_probable_prime(prime), prime)
        for composite in (1, 4, 561, 1105, 7917, 2 ** 61 + 1, 104729 * 7919):
            self.assertFalse(rsa.is_probable_prime(composite), composite)

    def test_sign_and_verify(self):
        key = rsa.generate(1024)
        self.assertEqual(key.n.bit_length(), 1024)
        self.assertEqual(key.p * key.q, key.n)
        signature = rsa.sign_sha256(key, b'hello lurker')
        self.assertEqual(len(signature), 128)
        self.assertTrue(rsa.verify_sha256(key.n, key.e, b'hello lurker', signature))
        self.assertFalse(rsa.verify_sha256(key.n, key.e, b'hello lurkers', signature))


class CertificateFileTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix='lurker-cert-test-')
        self.addCleanup(shutil.rmtree, self.directory, True)

    def generate(self):
        return cert.generate(self.directory, 'lurker-test', ['localhost', 'lurker-test.local'], ['127.0.0.1', '::1'])

    def test_files_and_permissions(self):
        made = self.generate()
        self.assertEqual(made.cert_path, os.path.join(self.directory, 'cert.pem'))
        self.assertEqual(made.key_path, os.path.join(self.directory, 'key.pem'))
        with open(made.cert_path) as handle:
            self.assertTrue(handle.read().startswith('-----BEGIN CERTIFICATE-----'))
        with open(made.key_path) as handle:
            self.assertTrue(handle.read().startswith('-----BEGIN PRIVATE KEY-----'))
        if os.name != 'nt':
            self.assertEqual(stat.S_IMODE(os.stat(made.key_path).st_mode), 0o600)
        self.assertEqual(sorted(os.listdir(self.directory)), ['cert.pem', 'key.pem'])

    def test_every_generation_replaces_the_previous_certificate(self):
        first = self.generate()
        with open(first.cert_path) as handle:
            first_pem = handle.read()
        second = self.generate()
        with open(second.cert_path) as handle:
            second_pem = handle.read()
        self.assertNotEqual(first.fingerprint, second.fingerprint)
        self.assertNotEqual(first_pem, second_pem)
        self.assertEqual(sorted(os.listdir(self.directory)), ['cert.pem', 'key.pem'])

    def test_python_can_load_and_decode_it(self):
        made = self.generate()
        context = cert.server_context(made)  # load_cert_chain checks that key and certificate match
        self.assertIsInstance(context, ssl.SSLContext)
        decode = getattr(ssl._ssl, '_test_decode_cert', None)
        if decode is None:
            self.skipTest('ssl._ssl._test_decode_cert is not available')
        info = decode(made.cert_path)
        self.assertEqual(info['version'], 3)
        self.assertIn((('commonName', 'lurker-test'),), info['subject'])
        self.assertIn(('DNS', 'localhost'), info['subjectAltName'])
        self.assertIn(('IP Address', '127.0.0.1'), info['subjectAltName'])

    @unittest.skipUnless(OPENSSL, 'openssl is not installed')
    def test_openssl_agrees(self):
        made = self.generate()
        text = subprocess.run([OPENSSL, 'x509', '-in', made.cert_path, '-noout', '-text'],
                              capture_output=True, text=True, check=True).stdout
        self.assertIn('Signature Algorithm: sha256WithRSAEncryption', text)
        self.assertIn('CA:FALSE', text)
        self.assertIn('TLS Web Server Authentication', text)
        self.assertIn('DNS:localhost', text)
        self.assertIn('IP Address:127.0.0.1', text)
        verified = subprocess.run([OPENSSL, 'verify', '-CAfile', made.cert_path, made.cert_path],
                                  capture_output=True, text=True)
        self.assertEqual(verified.returncode, 0, verified.stdout + verified.stderr)
        key_check = subprocess.run([OPENSSL, 'rsa', '-in', made.key_path, '-check', '-noout'],
                                   capture_output=True, text=True)
        self.assertIn('RSA key ok', key_check.stdout + key_check.stderr)

    def test_a_verifying_tls_client_accepts_it_for_localhost_and_127_0_0_1(self):
        made = self.generate()
        server_context = cert.server_context(made)
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen(2)
        self.addCleanup(listener.close)
        port = listener.getsockname()[1]
        import threading

        def serve():
            for _ in range(2):
                connection, _ = listener.accept()
                try:
                    with server_context.wrap_socket(connection, server_side=True) as tls:
                        tls.sendall(b'ok')
                except (ssl.SSLError, OSError):
                    pass

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        for name in ('localhost', '127.0.0.1'):
            client = ssl.create_default_context(cafile=made.cert_path)
            with socket.create_connection(('127.0.0.1', port), timeout=10) as raw:
                with client.wrap_socket(raw, server_hostname=name) as tls:
                    self.assertEqual(tls.recv(2), b'ok')
                    der = tls.getpeercert(binary_form=True)
                    digest = hashlib.sha256(der).hexdigest().upper()
                    self.assertEqual(made.fingerprint.replace(':', ''), digest)
        thread.join(5)

    def test_validity_period(self):
        key = rsa.generate(1024)
        now = datetime.datetime(2026, 9, 1, tzinfo=datetime.timezone.utc)
        der = x509.self_signed(key, 'x', ['localhost'], [], now=now)
        self.assertIn(b'260831230000Z', der)  # not before: one hour earlier
        self.assertIn(b'271003000000Z', der)  # not after: 397 days later


class HttpsServerTests(unittest.TestCase):
    def test_each_start_mints_a_new_certificate_and_older_processes_keep_theirs(self):
        first = RunningLurker(protocol='https')
        self.addCleanup(first.close)
        second_dir = first.cert_dir  # start a second instance on the SAME certificate directory
        from server.app import LurkerApp
        from server.config import Config
        second = LurkerApp(Config(protocol='https', port=0, host='127.0.0.1', cert_dir=second_dir)).start()
        second.start_in_background()
        self.addCleanup(second.close)
        self.assertNotEqual(first.app.certificate.fingerprint, second.certificate.fingerprint)
        with open(os.path.join(second_dir, 'cert.pem')) as handle:
            on_disk = ssl.PEM_cert_to_DER_cert(handle.read())
        self.assertEqual(hashlib.sha256(on_disk).hexdigest().upper(), second.certificate.fingerprint.replace(':', ''))
        # The first process still serves the certificate it made.
        context = ssl._create_unverified_context()
        with socket.create_connection(('127.0.0.1', first.port), timeout=10) as raw:
            with context.wrap_socket(raw, server_hostname='localhost') as tls:
                served = hashlib.sha256(tls.getpeercert(binary_form=True)).hexdigest().upper()
        self.assertEqual(served, first.app.certificate.fingerprint.replace(':', ''))


if __name__ == '__main__':
    unittest.main()
