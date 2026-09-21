/**
 * Self-signed X.509 certificate generation, in-process.
 *
 * The specification requires `npm start -- --https` to mint a NEW certificate on
 * every single run, even when `cert/` already holds one, and allows no npm
 * dependency other than `ws`. So the certificate is assembled here with the DER
 * primitives in `src/lib/asn1.js` and signed with `node:crypto`.
 *
 * A certificate produced here is a normal, standards-compliant self-signed
 * server certificate: browsers show the usual "not trusted" interstitial, and
 * accepting it works exactly as with an `openssl req -x509` certificate.
 *
 * If the in-process path ever fails on some exotic platform, `generate()` falls
 * back to the host's `openssl` binary. Nothing else in the app depends on that
 * binary being installed.
 *
 * Certificate layout (RFC 5280):
 *   Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
 *   TBSCertificate ::= SEQUENCE {
 *     [0] version(v3), serialNumber, signature, issuer, validity, subject,
 *     subjectPublicKeyInfo, [3] extensions }
 */
import { generateKeyPairSync, createSign, createHash, randomBytes, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { networkInterfaces, hostname } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as asn1 from './asn1.js';

/** Object identifiers used in the certificate. */
const OID = Object.freeze({
  commonName: '2.5.4.3',
  organizationName: '2.5.4.10',
  countryName: '2.5.4.6',
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  sha256WithRSAEncryption: '1.2.840.113549.1.1.11',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
});

/**
 * Every name the certificate should be valid for.
 *
 * Pellets is a LAN chat server, so the certificate covers localhost, the host
 * name and every non-internal IPv4/IPv6 address of the machine. Without this a
 * phone on the same Wi-Fi would get a name-mismatch error on top of the
 * expected self-signed warning.
 *
 * @param {string[]} [extra] Additional DNS names supplied by configuration.
 * @returns {{ dns: string[], ip: string[] }}
 */
export function collectSubjectAltNames(extra = []) {
  const dns = new Set(['localhost']);
  const ip = new Set(['127.0.0.1', '::1']);

  try {
    const host = hostname();
    if (host) {
      dns.add(host);
      // Also register the short name when the host is fully qualified.
      if (host.includes('.')) dns.add(host.split('.')[0]);
    }
  } catch {
    /* hostname() is best effort */
  }

  try {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses || []) {
        if (!address || address.internal) continue;
        // Node >= 18 reports family as the string 'IPv4'/'IPv6'.
        const value = String(address.address).split('%')[0];
        if (value) ip.add(value);
      }
    }
  } catch {
    /* networkInterfaces() is best effort */
  }

  for (const name of extra) {
    const value = String(name || '').trim();
    if (!value) continue;
    if (isIpAddress(value)) ip.add(value);
    else dns.add(value);
  }

  return { dns: [...dns], ip: [...ip] };
}

/** True for a literal IPv4 or IPv6 address. */
export function isIpAddress(value) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');
}

/**
 * Encode an IPv4/IPv6 literal as the 4 or 16 raw bytes an iPAddress
 * GeneralName requires.
 * @param {string} value
 * @returns {Buffer|null} null when the literal cannot be parsed.
 */
export function ipToBytes(value) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.').map((n) => Number.parseInt(n, 10));
    if (parts.some((n) => n < 0 || n > 255)) return null;
    return Buffer.from(parts);
  }

  if (!value.includes(':')) return null;
  // IPv6, including the "::" compressed form and IPv4-mapped tails.
  let text = value;
  let tail = Buffer.alloc(0);
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = ipToBytes(maybeV4);
    if (!v4) return null;
    tail = v4;
    text = text.slice(0, lastColon + 1) + '0:0';
  }

  const [head, rest] = text.split('::');
  const toGroups = (part) =>
    part
      .split(':')
      .filter((g) => g.length > 0)
      .map((g) => Number.parseInt(g, 16));

  const left = toGroups(head || '');
  const right = rest === undefined ? [] : toGroups(rest);
  const missing = 8 - left.length - right.length; // an IPv6 address is 8 groups
  if (rest === undefined && missing !== 0) return null;
  if (missing < 0) return null;

  const groups = [...left, ...new Array(missing).fill(0), ...right];
  if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;

  const out = Buffer.alloc(16);
  groups.forEach((group, index) => out.writeUInt16BE(group, index * 2));
  if (tail.length === 4) tail.copy(out, 12);
  return out;
}

/**
 * Build the DER `Name` for a distinguished name.
 * @param {{ commonName: string, organization?: string, country?: string }} dn
 */
function encodeName(dn) {
  const rdn = (attributeOid, value) => asn1.set(asn1.seq(asn1.oid(attributeOid), asn1.utf8String(value)));
  const parts = [rdn(OID.commonName, dn.commonName)];
  if (dn.organization) parts.push(rdn(OID.organizationName, dn.organization));
  if (dn.country) parts.push(asn1.set(asn1.seq(asn1.oid(OID.countryName), asn1.printableString(dn.country))));
  return asn1.seq(...parts);
}

/**
 * Extract the raw public key bits from a SubjectPublicKeyInfo so the Subject
 * Key Identifier can be the SHA-1 of the key, as RFC 5280 §4.2.1.2 method 1
 * describes.
 * @param {Buffer} spkiDer
 */
function publicKeyBits(spkiDer) {
  const outer = asn1.readTLV(spkiDer);
  const algorithm = asn1.readTLV(outer.value, 0);
  const keyBitString = asn1.readTLV(outer.value, algorithm.end);
  return keyBitString.value.subarray(1); // drop the "unused bits" prefix byte
}

/**
 * Build the extensions block.
 * @param {{ spkiDer: Buffer, altNames: { dns: string[], ip: string[] } }} input
 */
function encodeExtensions({ spkiDer, altNames }) {
  const extension = (id, critical, valueDer) =>
    asn1.seq(asn1.oid(id), ...(critical ? [asn1.boolean(true)] : []), asn1.octetString(valueDer));

  // GeneralName choices: dNSName is [2] IA5String, iPAddress is [7] OCTET STRING.
  const generalNames = [
    ...altNames.dns.map((name) => asn1.tlv(asn1.contextPrimitive(2), Buffer.from(name, 'ascii'))),
    ...altNames.ip
      .map((value) => ipToBytes(value))
      .filter(Boolean)
      .map((bytes) => asn1.tlv(asn1.contextPrimitive(7), bytes)),
  ];

  const keyId = createHash('sha1').update(publicKeyBits(spkiDer)).digest();

  // keyUsage bits: digitalSignature(0) | keyEncipherment(2) | keyCertSign(5)
  // => 0b10100100 = 0xA4 with the trailing 2 bits unused.
  const keyUsageBits = asn1.bitString(Buffer.from([0xa4]), 2);

  return asn1.explicit(
    3,
    asn1.seq(
      // cA:TRUE mirrors what `openssl req -x509` emits, so the certificate can
      // also be imported as a trust anchor for testing.
      extension(OID.basicConstraints, true, asn1.seq(asn1.boolean(true))),
      extension(OID.keyUsage, true, keyUsageBits),
      extension(OID.extKeyUsage, false, asn1.seq(asn1.oid(OID.serverAuth), asn1.oid(OID.clientAuth))),
      extension(OID.subjectKeyIdentifier, false, asn1.octetString(keyId)),
      extension(OID.subjectAltName, false, asn1.seq(...generalNames)),
    ),
  );
}

/**
 * Create a key pair and a matching self-signed certificate, entirely in-process.
 *
 * @param {object} [options]
 * @param {'ec'|'rsa'} [options.keyType] EC/P-256 by default: generation is
 *   effectively instant, which matters because this runs on every start.
 * @param {number} [options.days] Validity window in days.
 * @param {string} [options.commonName]
 * @param {string} [options.organization]
 * @param {string[]} [options.altNames] Extra DNS names or IPs.
 * @returns {{ key: string, cert: string, keyType: string, altNames: { dns: string[], ip: string[] }, serial: string, validFrom: Date, validTo: Date }}
 */
export function createSelfSignedCertificate(options = {}) {
  const keyType = options.keyType === 'rsa' ? 'rsa' : 'ec';
  const days = Number.isFinite(options.days) && options.days > 0 ? Math.floor(options.days) : 365;
  const commonName = options.commonName || 'pellets.local';
  const organization = options.organization || 'Pellets';
  const altNames = collectSubjectAltNames(options.altNames || []);

  const { publicKey, privateKey } =
    keyType === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  // The signature algorithm identifier: ECDSA carries no parameters at all,
  // RSA PKCS#1 v1.5 carries an explicit NULL.
  const signatureAlgorithm =
    keyType === 'rsa'
      ? asn1.seq(asn1.oid(OID.sha256WithRSAEncryption), asn1.nullValue())
      : asn1.seq(asn1.oid(OID.ecdsaWithSHA256));

  // Positive, non-zero, at most 20 octets (RFC 5280 §4.1.2.2).
  const serialBytes = randomBytes(16);
  serialBytes[0] &= 0x7f;
  serialBytes[0] |= 0x40;

  const validFrom = new Date(Date.now() - 60 * 60 * 1000); // an hour of clock skew
  const validTo = new Date(validFrom.getTime() + days * 24 * 60 * 60 * 1000);

  const name = encodeName({ commonName, organization });

  const tbsCertificate = asn1.seq(
    asn1.explicit(0, asn1.integer(2)), // version v3
    asn1.integer(serialBytes),
    signatureAlgorithm,
    name, // issuer === subject: self-signed
    asn1.seq(asn1.x509Time(validFrom), asn1.x509Time(validTo)),
    name,
    spkiDer,
    encodeExtensions({ spkiDer, altNames }),
  );

  const signature = createSign('sha256').update(tbsCertificate).sign(privateKey);
  const certificateDer = asn1.seq(tbsCertificate, signatureAlgorithm, asn1.bitString(signature));

  const result = {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: asn1.toPem('CERTIFICATE', certificateDer),
    keyType,
    altNames,
    serial: serialBytes.toString('hex'),
    validFrom,
    validTo,
  };

  // Fail loudly here rather than at TLS handshake time if the DER is malformed.
  // eslint-disable-next-line no-new
  new X509Certificate(result.cert);
  return result;
}

/**
 * Fallback generator that shells out to the host `openssl` binary.
 * Only used when the in-process generator throws.
 * @param {object} options Same shape as `createSelfSignedCertificate`.
 */
export function createSelfSignedCertificateWithOpenssl(options = {}) {
  const days = Number.isFinite(options.days) && options.days > 0 ? Math.floor(options.days) : 365;
  const commonName = options.commonName || 'pellets.local';
  const altNames = collectSubjectAltNames(options.altNames || []);
  const sanLine = [
    ...altNames.dns.map((name) => `DNS:${name}`),
    ...altNames.ip.map((value) => `IP:${value}`),
  ].join(',');

  const output = execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      '-',
      '-days',
      String(days),
      '-subj',
      `/CN=${commonName}/O=Pellets`,
      '-addext',
      `subjectAltName=${sanLine}`,
      '-addext',
      'extendedKeyUsage=serverAuth,clientAuth',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );

  const key = output.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----\n?/);
  const cert = output.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n?/);
  if (!key || !cert) throw new Error('openssl fallback produced unexpected output');

  const parsed = new X509Certificate(cert[0]);
  return {
    key: key[0],
    cert: cert[0],
    keyType: 'ec',
    altNames,
    serial: parsed.serialNumber,
    validFrom: new Date(parsed.validFrom),
    validTo: new Date(parsed.validTo),
  };
}

/**
 * Mint a certificate and write it to disk.
 *
 * ALWAYS overwrites: the specification is explicit that a fresh certificate is
 * created on every `--https` run even if `cert/` already contains one.
 *
 * @param {object} options
 * @param {string} options.directory Destination directory, created if missing.
 * @param {'ec'|'rsa'} [options.keyType]
 * @param {number} [options.days]
 * @param {string} [options.commonName]
 * @param {string[]} [options.altNames]
 * @param {{ warn: Function, debug: Function }} [options.logger]
 * @returns {{ key: string, cert: string, keyPath: string, certPath: string, keyType: string, altNames: object, serial: string, validFrom: Date, validTo: Date, generator: 'in-process'|'openssl' }}
 */
export function generateCertificateFiles(options) {
  const { directory, logger } = options;
  let material;
  let generator = 'in-process';

  try {
    material = createSelfSignedCertificate(options);
  } catch (error) {
    logger?.warn?.('in-process certificate generation failed, falling back to openssl:', error.message);
    material = createSelfSignedCertificateWithOpenssl(options);
    generator = 'openssl';
  }

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');
  // 0600 on the private key: it is regenerated constantly, but never world readable.
  writeFileSync(keyPath, material.key, { mode: 0o600 });
  writeFileSync(certPath, material.cert, { mode: 0o644 });

  return { ...material, keyPath, certPath, generator };
}

/**
 * Read back a certificate pair from disk. Used by tests and tooling; the server
 * itself never reuses a certificate.
 * @param {string} directory
 */
export function readCertificateFiles(directory) {
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');
  if (!existsSync(keyPath) || !existsSync(certPath)) return null;
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8'), keyPath, certPath };
}
