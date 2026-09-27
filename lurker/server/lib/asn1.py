"""The handful of DER (ASN.1) encoders an X.509 certificate needs."""
import datetime


def _length(size):
    if size < 0x80:
        return bytes([size])
    raw = size.to_bytes((size.bit_length() + 7) // 8, 'big')
    return bytes([0x80 | len(raw)]) + raw


def tlv(tag, content):
    return bytes([tag]) + _length(len(content)) + content


def integer(value):
    if value == 0:
        return tlv(0x02, b'\x00')
    size = (value.bit_length() + 8) // 8  # one spare bit keeps positive numbers positive
    return tlv(0x02, value.to_bytes(size, 'big', signed=True))


def boolean(value):
    return tlv(0x01, b'\xff' if value else b'\x00')


def null():
    return b'\x05\x00'


def octet_string(data):
    return tlv(0x04, data)


def bit_string(data, unused_bits=0):
    return tlv(0x03, bytes([unused_bits]) + data)


def utf8_string(text):
    return tlv(0x0C, text.encode('utf-8'))


def ia5_string(text):
    return tlv(0x16, text.encode('ascii'))


def oid(dotted):
    parts = [int(part) for part in dotted.split('.')]
    body = bytearray([parts[0] * 40 + parts[1]])
    for part in parts[2:]:
        chunk = [part & 0x7F]
        part >>= 7
        while part:
            chunk.append(0x80 | (part & 0x7F))
            part >>= 7
        body.extend(reversed(chunk))
    return tlv(0x06, bytes(body))


def sequence(*items):
    return tlv(0x30, b''.join(items))


def set_of(*items):
    return tlv(0x31, b''.join(sorted(items)))  # DER sorts SET OF members


def time(moment):
    """UTCTime before 2050 and GeneralizedTime after, as RFC 5280 requires."""
    moment = moment.astimezone(datetime.timezone.utc)
    if moment.year < 2050:
        return tlv(0x17, moment.strftime('%y%m%d%H%M%SZ').encode('ascii'))
    return tlv(0x18, moment.strftime('%Y%m%d%H%M%SZ').encode('ascii'))


def explicit(number, content):
    """[number] EXPLICIT: a constructed context-specific wrapper."""
    return tlv(0xA0 | number, content)


def implicit(number, content, constructed=False):
    """[number] IMPLICIT: `content` is the value bytes, without its own tag."""
    return tlv((0xA0 if constructed else 0x80) | number, content)
