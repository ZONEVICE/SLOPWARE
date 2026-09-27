"""Mint the HTTPS certificate: a new one on every start, replacing the last.

The files land in `cert/` inside the application directory (`cert.pem` and
`key.pem`). They are written under temporary names and renamed into place, so
a crash can never leave a key that does not match its certificate. Each
process keeps the certificate it generated in memory (its SSLContext), so two
HTTPS instances started from the same directory both keep working even though
`cert/` only holds the newest pair.
"""
import datetime
import hashlib
import os
import secrets
import ssl
from dataclasses import dataclass
from typing import List

from . import rsa, x509


@dataclass
class Certificate:
    cert_path: str
    key_path: str
    fingerprint: str        # SHA-256 of the DER certificate, colon-separated hex
    not_after: datetime.datetime
    dns_names: List[str]
    ip_addresses: List[str]


def generate(directory, common_name, dns_names, ip_addresses, bits=2048):
    os.makedirs(directory, mode=0o700, exist_ok=True)
    key = rsa.generate(bits)
    now = datetime.datetime.now(datetime.timezone.utc)
    der = x509.self_signed(key, common_name, dns_names, ip_addresses, now=now)
    cert_pem = x509.pem(der, 'CERTIFICATE')
    key_pem = x509.pem(rsa.private_key_pkcs8(key), 'PRIVATE KEY')

    cert_path = os.path.join(directory, 'cert.pem')
    key_path = os.path.join(directory, 'key.pem')
    suffix = secrets.token_hex(4)
    temporary_key = os.path.join(directory, '.key-%s.tmp' % suffix)
    temporary_cert = os.path.join(directory, '.cert-%s.tmp' % suffix)
    try:
        _write(temporary_key, key_pem, 0o600)
        _write(temporary_cert, cert_pem, 0o644)
        os.replace(temporary_key, key_path)
        os.replace(temporary_cert, cert_path)
    finally:
        for leftover in (temporary_key, temporary_cert):
            if os.path.exists(leftover):
                os.remove(leftover)

    digest = hashlib.sha256(der).hexdigest().upper()
    return Certificate(
        cert_path=cert_path,
        key_path=key_path,
        fingerprint=':'.join(digest[index:index + 2] for index in range(0, len(digest), 2)),
        not_after=now + datetime.timedelta(days=397),
        dns_names=list(dns_names),
        ip_addresses=list(ip_addresses),
    )


def server_context(certificate):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(certificate.cert_path, certificate.key_path)
    return context


def _write(path, text, mode):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(descriptor, 'w', encoding='ascii', newline='\n') as handle:
        handle.write(text)
