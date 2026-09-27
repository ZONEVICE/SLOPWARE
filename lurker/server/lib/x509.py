"""A self-signed X.509 v3 server certificate, encoded by hand (RFC 5280)."""
import base64
import datetime
import hashlib
import ipaddress
import secrets

from . import asn1, rsa

_COMMON_NAME = '2.5.4.3'
_ORGANIZATION = '2.5.4.10'
_BASIC_CONSTRAINTS = '2.5.29.19'
_KEY_USAGE = '2.5.29.15'
_EXT_KEY_USAGE = '2.5.29.37'
_SUBJECT_ALT_NAME = '2.5.29.17'
_SUBJECT_KEY_ID = '2.5.29.14'
_AUTHORITY_KEY_ID = '2.5.29.35'
_SERVER_AUTH = '1.3.6.1.5.5.7.3.1'


def _name(common_name, organization):
    return asn1.sequence(
        asn1.set_of(asn1.sequence(asn1.oid(_COMMON_NAME), asn1.utf8_string(common_name))),
        asn1.set_of(asn1.sequence(asn1.oid(_ORGANIZATION), asn1.utf8_string(organization))),
    )


def _extension(identifier, value, critical=False):
    parts = [asn1.oid(identifier)]
    if critical:
        parts.append(asn1.boolean(True))
    parts.append(asn1.octet_string(value))
    return asn1.sequence(*parts)


def _alt_names(dns_names, ip_addresses):
    names = []
    for name in dns_names:
        try:
            names.append(asn1.implicit(2, name.encode('ascii')))  # dNSName, IA5String
        except UnicodeEncodeError:
            continue  # an internationalised host name cannot go in a dNSName as-is
    for address in ip_addresses:
        try:
            names.append(asn1.implicit(7, ipaddress.ip_address(address).packed))  # iPAddress
        except ValueError:
            continue
    return asn1.sequence(*names)


def self_signed(key, common_name, dns_names=(), ip_addresses=(), days=397, organization='Lurker', now=None):
    """DER bytes of a certificate for `key`, signed by `key` itself.

    397 days is the longest validity browsers accept for server certificates;
    Lurker makes a new one on every start anyway.
    """
    now = now or datetime.datetime.now(datetime.timezone.utc)
    not_before = (now - datetime.timedelta(hours=1)).replace(microsecond=0)
    not_after = (now + datetime.timedelta(days=days)).replace(microsecond=0)
    serial = secrets.randbits(127) | (1 << 126)  # positive, 16 bytes, never reused
    name = _name(common_name, organization)
    public_key_info = rsa.subject_public_key_info(key)
    key_id = hashlib.sha1(rsa.public_key_der(key)).digest()
    algorithm = asn1.sequence(asn1.oid(rsa.SHA256_WITH_RSA), asn1.null())

    extensions = asn1.sequence(
        _extension(_BASIC_CONSTRAINTS, asn1.sequence(), critical=True),                  # CA:FALSE
        # digitalSignature (bit 0) + keyEncipherment (bit 2): 101 followed by 5 unused bits.
        _extension(_KEY_USAGE, asn1.bit_string(b'\xa0', unused_bits=5), critical=True),
        _extension(_EXT_KEY_USAGE, asn1.sequence(asn1.oid(_SERVER_AUTH))),
        _extension(_SUBJECT_ALT_NAME, _alt_names(dns_names, ip_addresses)),
        _extension(_SUBJECT_KEY_ID, asn1.octet_string(key_id)),
        _extension(_AUTHORITY_KEY_ID, asn1.sequence(asn1.implicit(0, key_id))),
    )
    tbs = asn1.sequence(
        asn1.explicit(0, asn1.integer(2)),        # version v3
        asn1.integer(serial),
        algorithm,
        name,                                     # issuer
        asn1.sequence(asn1.time(not_before), asn1.time(not_after)),
        name,                                     # subject: the same, it is self-signed
        public_key_info,
        asn1.explicit(3, extensions),
    )
    signature = rsa.sign_sha256(key, tbs)
    return asn1.sequence(tbs, algorithm, asn1.bit_string(signature))


def pem(der, label):
    body = base64.b64encode(der).decode('ascii')
    lines = [body[index:index + 64] for index in range(0, len(body), 64)]
    return '-----BEGIN %s-----\n%s\n-----END %s-----\n' % (label, '\n'.join(lines), label)
