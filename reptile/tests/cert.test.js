/**
 * Certificate generation with the system openssl.
 *
 * Checked: the files land in the directory, they parse as a real X.509
 * certificate with the expected names, the key matches (a live TLS handshake
 * succeeds), every run replaces the previous certificate with a new one, and
 * a missing openssl produces a message a person can act on.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import https from 'node:https';
import { hostname } from 'node:os';
import { buildOpensslConfig, generateCertificate } from '../src/lib/cert.js';
import { cleanup, startInstance, tempDir } from './helpers/instances.js';

after(cleanup);

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe('self-signed certificate', { skip: !hasOpenssl && 'openssl is not installed' }, () => {
  test('is written to the directory as key.pem and cert.pem', async () => {
    const directory = await tempDir();
    const result = generateCertificate({ directory, dns: ['localhost', 'reptile.test'], ip: ['127.0.0.1', '::1', '10.9.8.7'] });
    assert.deepEqual((await readdir(directory)).sort(), ['cert.pem', 'key.pem'], 'no temporary files are left behind');
    assert.equal(readFileSync(result.certPath, 'utf8'), result.cert);
    assert.equal(statSync(result.keyPath).mode & 0o777, 0o600, 'the private key is private');
  });

  test('is a real X.509 server certificate with the right names', async () => {
    const directory = await tempDir();
    const result = generateCertificate({ directory, commonName: 'box.local', dns: ['localhost', 'box.local'], ip: ['127.0.0.1', '192.168.1.50'] });
    const certificate = new X509Certificate(result.cert);
    assert.match(certificate.subject, /CN=box\.local/);
    assert.equal(certificate.issuer, certificate.subject, 'self-signed');
    assert.ok(certificate.checkPrivateKey((await import('node:crypto')).createPrivateKey(result.key)));
    const san = certificate.subjectAltName;
    for (const name of ['DNS:localhost', 'DNS:box.local', 'IP Address:127.0.0.1', 'IP Address:192.168.1.50']) {
      assert.ok(san.includes(name), `${name} in ${san}`);
    }
    assert.equal(certificate.ca, false);
    assert.ok(new Date(certificate.validTo) > new Date(Date.now() + 300 * 24 * 3600 * 1000));
  });

  test('every run replaces the previous certificate with a new one', async () => {
    const directory = await tempDir();
    const first = generateCertificate({ directory });
    const firstKey = readFileSync(first.keyPath, 'utf8');
    const second = generateCertificate({ directory });
    assert.notEqual(first.fingerprint256, second.fingerprint256);
    assert.notEqual(readFileSync(second.keyPath, 'utf8'), firstKey);
    assert.equal(new X509Certificate(readFileSync(second.certPath)).fingerprint256, second.fingerprint256);
  });

  test('serves TLS: a client completes a handshake with it', async () => {
    const directory = await tempDir();
    const { key, cert, fingerprint256 } = generateCertificate({ directory });
    const server = https.createServer({ key, cert }, (req, res) => res.end('secure'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { body, seen } = await new Promise((resolve, reject) => {
        https
          .get({ host: '127.0.0.1', port: server.address().port, path: '/', rejectUnauthorized: false, agent: false }, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve({ body: data, seen: res.socket.getPeerCertificate().fingerprint256 }));
          })
          .on('error', reject);
      });
      assert.equal(body, 'secure');
      assert.equal(seen, fingerprint256);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('a missing openssl binary gives an actionable message', async () => {
    const directory = await tempDir();
    assert.throws(
      () => generateCertificate({ directory, openssl: '/nonexistent/openssl' }),
      (error) => error.code === 'OPENSSL_MISSING' && /--http/.test(error.message),
    );
  });

  test('the OpenSSL configuration is not injectable through host names', () => {
    const config = buildOpensslConfig({ commonName: 'x\n[evil]', dns: ['ok.local', 'bad name\nDNS.9 = evil'], ip: ['127.0.0.1', 'nope'], keyType: 'ec' });
    assert.ok(!config.includes('evil'));
    assert.ok(config.includes('DNS.1 = ok.local'));
    assert.ok(config.includes('CN = reptile.local'));
    assert.ok(config.includes('keyUsage = critical, digitalSignature'));
  });

  test('an HTTPS instance generates its certificate at startup and serves with it', async () => {
    const instance = await startInstance({ protocol: 'https' });
    const certificate = new X509Certificate(readFileSync(`${instance.certDir}/cert.pem`));
    assert.equal(certificate.fingerprint256, instance.app.tls.fingerprint256);
    assert.ok(certificate.subjectAltName.includes('DNS:localhost'));
    assert.ok(certificate.subjectAltName.includes(`DNS:${hostname()}`) || !/^[A-Za-z0-9.-]+$/.test(hostname()));
    const ping = await instance.api('GET', '/api/ping');
    assert.equal(ping.data.protocol, 'https');

    // A second start in the same directory replaces the certificate.
    const again = await startInstance({ protocol: 'https', certDir: instance.certDir });
    assert.notEqual(again.app.tls.fingerprint256, instance.app.tls.fingerprint256);
    assert.equal(new X509Certificate(readFileSync(`${instance.certDir}/cert.pem`)).fingerprint256, again.app.tls.fingerprint256);
  });
});
