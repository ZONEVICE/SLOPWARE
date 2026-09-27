"""RSA key generation and PKCS#1 v1.5 signatures, in pure Python.

The standard library can serve TLS but cannot create a certificate, and Lurker
may not depend on anything else, so the self-signed certificate is built by
hand. RSA was chosen over ECDSA because it needs nothing but modular
exponentiation, which Python's built-in `pow` does in C: a 2048-bit key takes
well under a second.
"""
import hashlib
import secrets

from . import asn1

# Trial division by the small primes removes most composite candidates before
# the (comparatively expensive) Miller-Rabin rounds.
_SMALL_PRIMES = []
_sieve = bytearray([1]) * 2000
for _n in range(2, 2000):
    if _sieve[_n]:
        _SMALL_PRIMES.append(_n)
        _sieve[_n * _n::_n] = bytearray(len(_sieve[_n * _n::_n]))
del _sieve, _n

# DER prefix of DigestInfo { AlgorithmIdentifier sha256, OCTET STRING (32 bytes) }.
_SHA256_DIGEST_INFO = bytes.fromhex('3031300d060960864801650304020105000420')

RSA_ENCRYPTION = '1.2.840.113549.1.1.1'
SHA256_WITH_RSA = '1.2.840.113549.1.1.11'


class RsaKey:
    __slots__ = ('n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qinv')

    def __init__(self, n, e, d, p, q):
        self.n, self.e, self.d, self.p, self.q = n, e, d, p, q
        self.dp = d % (p - 1)
        self.dq = d % (q - 1)
        self.qinv = pow(q, -1, p)

    @property
    def size_bytes(self):
        return (self.n.bit_length() + 7) // 8


def is_probable_prime(candidate, rounds=40):
    if candidate < 2:
        return False
    for prime in _SMALL_PRIMES:
        if candidate % prime == 0:
            return candidate == prime
    odd, twos = candidate - 1, 0
    while odd % 2 == 0:
        odd //= 2
        twos += 1
    for _ in range(rounds):
        witness = 2 + secrets.randbelow(candidate - 3)
        x = pow(witness, odd, candidate)
        if x in (1, candidate - 1):
            continue
        for _ in range(twos - 1):
            x = pow(x, 2, candidate)
            if x == candidate - 1:
                break
        else:
            return False
    return True


def _random_prime(bits, e):
    while True:
        # The two top bits are set so that p*q has exactly 2*bits bits.
        candidate = secrets.randbits(bits) | (0b11 << (bits - 2)) | 1
        if any(candidate % prime == 0 for prime in _SMALL_PRIMES):
            continue
        if (candidate - 1) % e == 0:
            continue
        # 40 rounds on random candidates is far beyond what FIPS 186-4 asks.
        if is_probable_prime(candidate, rounds=40):
            return candidate


def generate(bits=2048, e=65537):
    while True:
        p = _random_prime(bits // 2, e)
        q = _random_prime(bits // 2, e)
        if p == q:
            continue
        n = p * q
        if n.bit_length() != bits:
            continue
        phi = (p - 1) * (q - 1)
        d = pow(e, -1, phi)
        if p < q:
            p, q = q, p  # PKCS#1 convention; also keeps qinv = q^-1 mod p well defined
        return RsaKey(n, e, d, p, q)


def _private_op(key, value):
    """value^d mod n with the Chinese remainder theorem (about 3x faster)."""
    m1 = pow(value, key.dp, key.p)
    m2 = pow(value, key.dq, key.q)
    h = (key.qinv * (m1 - m2)) % key.p
    return m2 + h * key.q


def sign_sha256(key, message):
    """RSASSA-PKCS1-v1_5 signature of `message` with SHA-256."""
    digest_info = _SHA256_DIGEST_INFO + hashlib.sha256(message).digest()
    size = key.size_bytes
    padding = b'\xff' * (size - len(digest_info) - 3)
    encoded = int.from_bytes(b'\x00\x01' + padding + b'\x00' + digest_info, 'big')
    signature = _private_op(key, encoded)
    # A fault during the CRT computation could leak the key; check before use.
    if pow(signature, key.e, key.n) != encoded:
        raise ArithmeticError('RSA signature self-check failed')
    return signature.to_bytes(size, 'big')


def verify_sha256(n, e, message, signature):
    size = (n.bit_length() + 7) // 8
    if len(signature) != size:
        return False
    recovered = pow(int.from_bytes(signature, 'big'), e, n).to_bytes(size, 'big')
    digest_info = _SHA256_DIGEST_INFO + hashlib.sha256(message).digest()
    padding = b'\xff' * (size - len(digest_info) - 3)
    return secrets.compare_digest(recovered, b'\x00\x01' + padding + b'\x00' + digest_info)


def public_key_der(key):
    """PKCS#1 RSAPublicKey."""
    return asn1.sequence(asn1.integer(key.n), asn1.integer(key.e))


def subject_public_key_info(key):
    return asn1.sequence(
        asn1.sequence(asn1.oid(RSA_ENCRYPTION), asn1.null()),
        asn1.bit_string(public_key_der(key)),
    )


def private_key_pkcs8(key):
    """PKCS#8 PrivateKeyInfo wrapping a PKCS#1 RSAPrivateKey ("BEGIN PRIVATE KEY")."""
    rsa_private = asn1.sequence(
        asn1.integer(0),
        asn1.integer(key.n), asn1.integer(key.e), asn1.integer(key.d),
        asn1.integer(key.p), asn1.integer(key.q),
        asn1.integer(key.dp), asn1.integer(key.dq), asn1.integer(key.qinv),
    )
    return asn1.sequence(
        asn1.integer(0),
        asn1.sequence(asn1.oid(RSA_ENCRYPTION), asn1.null()),
        asn1.octet_string(rsa_private),
    )
