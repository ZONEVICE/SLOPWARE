"""Bounded random access over a file or a byte string, plus integer helpers.

Readers never trust a length or an offset found in a file: every read goes
through a Source, which clamps to the real size, and a reader that meets
something impossible raises Malformed. The probe turns any of these errors
into "no metadata" for that file instead of a crash.
"""
import struct


class Malformed(ValueError):
    """The bytes do not look like the format they claim to be."""


class Source:
    """A window over a seekable binary file: offsets are relative to `base`."""

    def __init__(self, handle, size, base=0):
        self.handle = handle
        self.size = max(0, size)
        self.base = base

    def read(self, offset, length):
        if offset < 0 or length <= 0 or offset >= self.size:
            return b''
        length = min(length, self.size - offset)
        self.handle.seek(self.base + offset)
        return self.handle.read(length)

    def exact(self, offset, length):
        data = self.read(offset, length)
        if len(data) != length:
            raise Malformed('truncated at %d' % offset)
        return data

    def window(self, offset, length):
        """A Source over [offset, offset + length) of this one."""
        if offset < 0 or offset > self.size:
            raise Malformed('window outside the file')
        return Source(self.handle, min(length, self.size - offset), self.base + offset)


class BytesSource:
    """The same interface over bytes already in memory."""

    def __init__(self, data, base=0, size=None):
        self.data = data
        self.base = base
        self.size = len(data) - base if size is None else min(size, len(data) - base)

    def read(self, offset, length):
        if offset < 0 or length <= 0 or offset >= self.size:
            return b''
        start = self.base + offset
        return bytes(self.data[start:start + min(length, self.size - offset)])

    def exact(self, offset, length):
        data = self.read(offset, length)
        if len(data) != length:
            raise Malformed('truncated at %d' % offset)
        return data

    def window(self, offset, length):
        if offset < 0 or offset > self.size:
            raise Malformed('window outside the data')
        return BytesSource(self.data, self.base + offset, min(length, self.size - offset))


def u8(data, offset):
    return data[offset]


def u16be(data, offset):
    return struct.unpack_from('>H', data, offset)[0]


def u16le(data, offset):
    return struct.unpack_from('<H', data, offset)[0]


def u24le(data, offset):
    return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16)


def u32be(data, offset):
    return struct.unpack_from('>I', data, offset)[0]


def u32le(data, offset):
    return struct.unpack_from('<I', data, offset)[0]


def s32be(data, offset):
    return struct.unpack_from('>i', data, offset)[0]


def s32le(data, offset):
    return struct.unpack_from('<i', data, offset)[0]


def u64be(data, offset):
    return struct.unpack_from('>Q', data, offset)[0]
