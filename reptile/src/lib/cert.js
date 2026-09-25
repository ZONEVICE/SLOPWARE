/**
 * Self-signed certificate generation with the system `openssl` binary.
 *
 * `npm start -- --https` must mint a NEW certificate on every run, replacing the
 * previous one in `cert/`, and chokidar is the only npm package Reptile may
 * use. So the certificate comes from the host's `openssl` command, driven by a
 * throw-away configuration file instead of the system `openssl.cnf`: the system
 * file differs between distributions and OpenSSL versions (some add
 * `CA:TRUE`, some lack `-addext`), and a private config makes the result
 * identical everywhere OpenSSL 1.1.1 or newer runs.
 *
 * The certificate is a normal self-signed server certificate. Browsers show
 * their usual warning once; peers accept it because instance-to-instance
 * requests are made with `rejectUnauthorized: false` and then pinned to the
 * fingerprint seen at connection time (see `src/peer/client.js`).
 */
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomHex } from './ids.js';
import { isIpv4 } from './net.js';

/** A DNS name safe to put in an OpenSSL config value. */
const DNS_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
/** Loose IPv6 literal check; OpenSSL validates the rest. */
const IPV6 = /^[0-9A-Fa-f:.]+$/;

/**
 * Build the OpenSSL configuration for `openssl req -x509`.
 *
 * @param {{ commonName: string, dns: string[], ip: string[], keyType: 'ec'|'rsa' }} input
 * @returns {string}
 */
export function buildOpensslConfig({ commonName, dns, ip, keyType }) {
  const dnsNames = [...new Set(dns)].filter((name) => DNS_NAME.test(name));
  const ipNames = [...new Set(ip)].filter((address) => isIpv4(address) || (address.includes(':') && IPV6.test(address)));
  const cn = DNS_NAME.test(commonName) ? commonName : 'reptile.local';

  const alt = [
    ...dnsNames.map((name, index) => `DNS.${index + 1} = ${name}`),
    ...ipNames.map((address, index) => `IP.${index + 1} = ${address}`),
  ];

  // An EC key cannot encipher; advertising keyEncipherment for it makes some
  // TLS stacks reject the certificate outright.
  const keyUsage = keyType === 'rsa' ? 'critical, digitalSignature, keyEncipherment' : 'critical, digitalSignature';

  return [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = v3',
    'prompt = no',
    '',
    '[dn]',
    `CN = ${cn}`,
    'O = Reptile',
    '',
    '[v3]',
    'basicConstraints = critical, CA:FALSE',
    `keyUsage = ${keyUsage}`,
    'extendedKeyUsage = serverAuth',
    'subjectKeyIdentifier = hash',
    'subjectAltName = @alt',
    '',
    '[alt]',
    ...alt,
    '',
  ].join('\n');
}

/**
 * Generate a fresh self-signed certificate and install it in `directory`,
 * replacing whatever `key.pem` / `cert.pem` were there before.
 *
 * Files are written under temporary names and renamed into place, so an
 * interrupted run never leaves a key that does not match its certificate.
 *
 * @param {object} options
 * @param {string} options.directory Destination, created when missing.
 * @param {string} [options.commonName]
 * @param {string[]} [options.dns] Subject alternative DNS names.
 * @param {string[]} [options.ip] Subject alternative IP addresses.
 * @param {number} [options.days]
 * @param {'ec'|'rsa'} [options.keyType] EC P-256 by default; RSA is the fallback.
 * @param {string} [options.openssl] Binary to run.
 * @returns {{ key: string, cert: string, keyPath: string, certPath: string, fingerprint256: string, keyType: string, validTo: string }}
 */
export function generateCertificate({
  directory,
  commonName = 'reptile.local',
  dns = ['localhost'],
  ip = ['127.0.0.1', '::1'],
  days = 365,
  keyType = 'ec',
  openssl = process.env.REPTILE_OPENSSL || 'openssl',
}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const suffix = randomHex(4);
  const configPath = join(directory, `.openssl-${suffix}.cnf`);
  const tmpKey = join(directory, `.key-${suffix}.pem`);
  const tmpCert = join(directory, `.cert-${suffix}.pem`);
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');

  const attempt = (type) => {
    writeFileSync(configPath, buildOpensslConfig({ commonName, dns, ip, keyType: type }), { mode: 0o600 });
    const keyArgs =
      type === 'ec' ? ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'] : ['-newkey', 'rsa:2048'];
    execFileSync(
      openssl,
      [
        'req',
        '-x509',
        '-config',
        configPath,
        ...keyArgs,
        '-nodes',
        '-sha256',
        '-days',
        String(days),
        '-keyout',
        tmpKey,
        '-out',
        tmpCert,
      ],
      // OPENSSL_CONF would otherwise be read and could inject extensions.
      { stdio: 'pipe', env: { ...process.env, OPENSSL_CONF: configPath }, timeout: 30_000 },
    );
    return type;
  };

  let usedType;
  try {
    try {
      usedType = attempt(keyType);
    } catch (error) {
      if (error.code === 'ENOENT') throw error;
      // Very old or unusual OpenSSL builds may lack EC support: try RSA once.
      if (keyType === 'rsa') throw error;
      usedType = attempt('rsa');
    }

    chmodSync(tmpKey, 0o600);
    renameSync(tmpKey, keyPath);
    renameSync(tmpCert, certPath);
  } catch (error) {
    rmSync(tmpKey, { force: true });
    rmSync(tmpCert, { force: true });
    if (error.code === 'ENOENT') {
      const friendly = new Error(
        `HTTPS needs the "${openssl}" command-line tool, which was not found. ` +
          'Install OpenSSL, or start Reptile with --http.',
      );
      friendly.code = 'OPENSSL_MISSING';
      friendly.cause = error;
      throw friendly;
    }
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    const friendly = new Error(`openssl could not generate a certificate: ${detail}`);
    friendly.code = 'OPENSSL_FAILED';
    friendly.cause = error;
    throw friendly;
  } finally {
    rmSync(configPath, { force: true });
  }

  const key = readFileSync(keyPath, 'utf8');
  const cert = readFileSync(certPath, 'utf8');
  const parsed = new X509Certificate(cert);
  return {
    key,
    cert,
    keyPath,
    certPath,
    keyType: usedType,
    fingerprint256: parsed.fingerprint256,
    validTo: parsed.validTo,
  };
}
