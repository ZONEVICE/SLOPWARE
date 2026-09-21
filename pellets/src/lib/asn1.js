/**
 * Minimal ASN.1 DER encoder/decoder.
 *
 * WHY THIS EXISTS: the specification allows exactly one npm dependency (`ws`),
 * yet `--https` must mint a brand new self-signed certificate on every start.
 * X.509 certificates are DER structures, so Pellets encodes them by hand here
 * and signs them with `node:crypto`. See `src/lib/selfSignedCert.js` for the
 * certificate layout that uses these primitives.
 *
 * Only the subset of DER that X.509 needs is implemented. Everything returns a
 * Buffer, so structures compose by nesting calls:
 *   seq(oid('2.5.4.3'), utf8String('pellets'))
 */

/** DER tag numbers used by this module. */
export const TAG = Object.freeze({
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
});

/** Context-specific constructed tag, i.e. `[n] EXPLICIT`. */
export const contextConstructed = (n) => 0xa0 | n;
/** Context-specific primitive tag, i.e. `[n] IMPLICIT`. */
export const contextPrimitive = (n) => 0x80 | n;

/**
 * DER definite length encoding: short form below 128, long form above.
 * @param {number} length
 * @returns {Buffer}
 */
export function encodeLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/**
 * Wrap content in a tag-length-value triple.
 * @param {number} tag
 * @param {...(Buffer|Buffer[])} parts
 * @returns {Buffer}
 */
export function tlv(tag, ...parts) {
  const body = Buffer.concat(parts.flat().map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

/** SEQUENCE { ...parts } */
export const seq = (...parts) => tlv(TAG.SEQUENCE, parts);
/** SET { ...parts } */
export const set = (...parts) => tlv(TAG.SET, parts);
/** `[n] EXPLICIT { ...parts }` */
export const explicit = (n, ...parts) => tlv(contextConstructed(n), parts);

/**
 * INTEGER. Accepts a non-negative JS integer or a big-endian magnitude Buffer.
 * DER requires the minimal two's-complement form, so leading zeros are stripped
 * and a 0x00 pad is added when the top bit would make the value look negative.
 * @param {number|Buffer} value
 */
export function integer(value) {
  let buf;
  if (Buffer.isBuffer(value)) {
    buf = Buffer.from(value);
  } else {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError('integer() expects a non-negative integer or a Buffer');
    }
    if (value === 0) return tlv(TAG.INTEGER, Buffer.from([0x00]));
    const bytes = [];
    let remaining = value;
    while (remaining > 0) {
      bytes.unshift(remaining & 0xff);
      remaining = Math.floor(remaining / 256);
    }
    buf = Buffer.from(bytes);
  }

  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0x00) start += 1;
  buf = buf.subarray(start);
  if (buf.length === 0) buf = Buffer.from([0x00]);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return tlv(TAG.INTEGER, buf);
}

/** BOOLEAN. DER mandates 0xFF for true. */
export const boolean = (value) => tlv(TAG.BOOLEAN, Buffer.from([value ? 0xff : 0x00]));

/** NULL */
export const nullValue = () => Buffer.from([TAG.NULL, 0x00]);

/** OCTET STRING */
export const octetString = (buf) => tlv(TAG.OCTET_STRING, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));

/**
 * BIT STRING. `unused` is the number of ignored bits in the final byte.
 * @param {Buffer} buf
 * @param {number} [unused]
 */
export const bitString = (buf, unused = 0) =>
  tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([unused]), Buffer.isBuffer(buf) ? buf : Buffer.from(buf)]));

/** UTF8String */
export const utf8String = (value) => tlv(TAG.UTF8_STRING, Buffer.from(String(value), 'utf8'));
/** PrintableString */
export const printableString = (value) => tlv(TAG.PRINTABLE_STRING, Buffer.from(String(value), 'ascii'));
/** IA5String */
export const ia5String = (value) => tlv(TAG.IA5_STRING, Buffer.from(String(value), 'ascii'));

/**
 * OBJECT IDENTIFIER from dotted notation, e.g. "2.5.29.17".
 * The first two arcs share a byte (40*a + b); the rest use base-128 with a
 * continuation bit on every byte but the last.
 * @param {string} dotted
 */
export function oid(dotted) {
  const arcs = String(dotted)
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  if (arcs.length < 2 || arcs.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new RangeError(`Invalid OID: ${dotted}`);
  }

  const bytes = [40 * arcs[0] + arcs[1]];
  for (let index = 2; index < arcs.length; index += 1) {
    let value = arcs[index];
    const chunk = [value & 0x7f];
    value = Math.floor(value / 128);
    while (value > 0) {
      chunk.unshift((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    bytes.push(...chunk);
  }
  return tlv(TAG.OID, Buffer.from(bytes));
}

/**
 * UTCTime ("YYMMDDHHMMSSZ"). RFC 5280 requires UTCTime for dates before 2050
 * and GeneralizedTime from 2050 on; `x509Time` picks the right one.
 * @param {Date} date
 */
export function utcTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const value =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return tlv(TAG.UTC_TIME, Buffer.from(value, 'ascii'));
}

/** GeneralizedTime ("YYYYMMDDHHMMSSZ"). */
export function generalizedTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const value =
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return tlv(TAG.GENERALIZED_TIME, Buffer.from(value, 'ascii'));
}

/** RFC 5280 `Time`: UTCTime through 2049, GeneralizedTime afterwards. */
export const x509Time = (date) => (date.getUTCFullYear() < 2050 ? utcTime(date) : generalizedTime(date));

/**
 * Read one TLV out of a buffer. Just enough decoding to inspect a structure we
 * built, e.g. to pull the public key bits out of a SubjectPublicKeyInfo.
 * @param {Buffer} buf
 * @param {number} [offset]
 * @returns {{ tag:number, header:number, length:number, value:Buffer, end:number }}
 */
export function readTLV(buf, offset = 0) {
  if (offset >= buf.length) throw new RangeError('readTLV: offset past end of buffer');
  const tag = buf[offset];
  let cursor = offset + 1;
  let length = buf[cursor];
  cursor += 1;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0) throw new RangeError('readTLV: indefinite length is not valid DER');
    length = 0;
    for (let index = 0; index < count; index += 1) {
      length = length * 256 + buf[cursor];
      cursor += 1;
    }
  }
  const end = cursor + length;
  if (end > buf.length) throw new RangeError('readTLV: truncated value');
  return { tag, header: cursor - offset, length, value: buf.subarray(cursor, end), end };
}

/**
 * Wrap DER bytes as PEM.
 * @param {string} label e.g. "CERTIFICATE"
 * @param {Buffer} der
 */
export function toPem(label, der) {
  const base64 = der.toString('base64');
  const lines = base64.match(/.{1,64}/g) || [''];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
