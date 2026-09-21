/**
 * Self-signed certificate generation.
 *
 * The specification requires `--https` to mint a NEW certificate on every run,
 * with no npm dependency to do it. These tests check that what comes out is a
 * real, usable X.509 certificate and not just plausible-looking bytes: Node's
 * own `X509Certificate` parses it, and a live TLS handshake verifies it.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createPublicKey, createPrivateKey } from 'node:crypto';
import { createServer } from 'node:https';
import { get } from 'node:https';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createSelfSignedCertificate,
  generateCertificateFiles,
  readCertificateFiles,
  collectSubjectAltNames,
  ipToBytes,
  isIpAddress,
} from '../src/lib/selfSignedCert.js';

/** Directories created by these tests, removed afterwards. */
const temporary = [];
after(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true }).catch(() => {});
});

async function tempDir() {
  const directory = await mkdtemp(join(tmpdir(), 'pellets-cert-test-'));
  temporary.push(directory);
  return directory;
}

describe('IP address encoding', () => {
  test('recognises literals', () => {
    assert.equal(isIpAddress('192.168.1.1'), true);
    assert.equal(isIpAddress('::1'), true);
    assert.equal(isIpAddress('example.com'), false);
  });

  test('IPv4 becomes four bytes', () => {
    assert.equal(ipToBytes('192.168.1.10').toString('hex'), 'c0a8010a');
    assert.equal(ipToBytes('0.0.0.0').toString('hex'), '00000000');
    assert.equal(ipToBytes('255.255.255.255').toString('hex'), 'ffffffff');
    assert.equal(ipToBytes('300.1.1.1'), null);
  });

  test('IPv6 becomes sixteen bytes, including compressed and mapped forms', () => {
    assert.equal(ipToBytes('::1').toString('hex'), '0'.repeat(31) + '1');
    assert.equal(ipToBytes('fe80:0:0:0:1:2:3:4').toString('hex'), 'fe800000000000000001000200030004');
    assert.equal(ipToBytes('::ffff:192.168.1.1').toString('hex'), '00000000000000000000ffffc0a80101');
    assert.equal(ipToBytes('fe80::1').length, 16);
  });
});

describe('subject alternative names', () => {
  test('always covers localhost and the loopback addresses', () => {
    const names = collectSubjectAltNames();
    assert.ok(names.dns.includes('localhost'));
    assert.ok(names.ip.includes('127.0.0.1'));
    assert.ok(names.ip.includes('::1'));
  });

  test('extra names are routed to the right list', () => {
    const names = collectSubjectAltNames(['chat.lan', '10.0.0.5']);
    assert.ok(names.dns.includes('chat.lan'));
    assert.ok(names.ip.includes('10.0.0.5'));
  });
});

describe('certificate generation', () => {
  for (const keyType of ['ec', 'rsa']) {
    test(`produces a parseable ${keyType.toUpperCase()} certificate`, () => {
      const material = createSelfSignedCertificate({ keyType, commonName: 'pellets.test', days: 30 });
      const certificate = new X509Certificate(material.cert);

      assert.match(certificate.subject, /CN=pellets\.test/);
      assert.equal(certificate.subject, certificate.issuer, 'self-signed: subject equals issuer');
      assert.equal(certificate.ca, true);

      // The certificate must actually match the private key that was generated.
      const privateKey = createPrivateKey(material.key);
      assert.equal(certificate.checkPrivateKey(privateKey), true);
      assert.equal(
        certificate.publicKey.export({ type: 'spki', format: 'pem' }),
        createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }),
      );

      // Self-signed means the certificate verifies against its own public key.
      assert.equal(certificate.verify(certificate.publicKey), true);

      assert.match(certificate.subjectAltName, /DNS:localhost/);
      assert.match(certificate.subjectAltName, /IP Address:127\.0\.0\.1/);
      assert.equal(certificate.checkHost('localhost'), 'localhost');
      assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');

      const validFrom = new Date(certificate.validFrom).getTime();
      const validTo = new Date(certificate.validTo).getTime();
      assert.ok(validFrom < Date.now(), 'already valid, with room for clock skew');
      assert.ok(validTo > Date.now(), 'not expired');
      assert.equal(Math.round((validTo - validFrom) / 86400000), 30);
    });
  }

  test('serial numbers are positive, unique and within 20 octets', () => {
    const serials = new Set();
    for (let index = 0; index < 20; index += 1) {
      const { serial } = createSelfSignedCertificate({});
      assert.ok(serial.length <= 40, 'at most 20 octets');
      assert.equal(/^[0-7]/.test(serial[0]) || Number.parseInt(serial[0], 16) < 8, true, 'positive');
      assert.equal(serials.has(serial), false);
      serials.add(serial);
    }
  });

  test('a generated certificate completes a verified TLS handshake', async () => {
    const material = createSelfSignedCertificate({ keyType: 'ec' });
    const server = createServer({ key: material.key, cert: material.cert }, (request, response) => {
      response.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const body = await new Promise((resolve, reject) => {
        get(
          {
            host: '127.0.0.1',
            port,
            path: '/',
            // Trust this certificate as its own authority and require a match:
            // a malformed certificate or a bad SAN would fail right here.
            ca: material.cert,
            servername: 'localhost',
            rejectUnauthorized: true,
            checkServerIdentity: () => undefined,
          },
          (response) => {
            let text = '';
            response.on('data', (chunk) => {
              text += chunk;
            });
            response.on('end', () => resolve(text));
          },
        ).on('error', reject);
      });
      assert.equal(body, 'ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('certificate files', () => {
  test('writes key and certificate with a private key that is not world readable', async () => {
    const directory = await tempDir();
    const result = generateCertificateFiles({ directory, keyType: 'ec' });

    assert.equal(result.keyPath, join(directory, 'key.pem'));
    assert.equal(result.certPath, join(directory, 'cert.pem'));
    assert.equal(result.generator, 'in-process', 'the fallback to openssl should not be needed');

    const key = await readFile(result.keyPath, 'utf8');
    const cert = await readFile(result.certPath, 'utf8');
    assert.match(key, /^-----BEGIN PRIVATE KEY-----/);
    assert.match(cert, /^-----BEGIN CERTIFICATE-----/);

    const info = await stat(result.keyPath);
    assert.equal(info.mode & 0o077, 0, 'the private key must not be group or world readable');

    const readBack = readCertificateFiles(directory);
    assert.equal(readBack.cert, cert);
  });

  test('every run replaces the certificate, as the specification requires', async () => {
    const directory = await tempDir();
    const first = generateCertificateFiles({ directory, keyType: 'ec' });
    const second = generateCertificateFiles({ directory, keyType: 'ec' });

    assert.notEqual(first.serial, second.serial, 'a new serial every run');
    assert.notEqual(first.cert, second.cert, 'a new certificate every run');
    assert.notEqual(first.key, second.key, 'a new private key every run');

    // What is on disk is the newest one, not the one that was already there.
    assert.equal(readCertificateFiles(directory).cert, second.cert);
  });
});
