"""Strict PNG auditor for the microscopy imaging pipeline.

The auditor parses a PNG byte stream under a strict structural policy so
that an archived file is guaranteed to correspond to exactly one decoded
pixel matrix: the signature, chunk ordering, chunk lengths and CRCs are
validated, IDAT chunks must be consecutive and inflate to exactly the
expected scanline bytes, and the five standard row filters are reversed
before hashing. Only 8-bit, non-interlaced grayscale and RGBA images with
dimensions in 1..4096 are accepted.
"""

from __future__ import annotations

import hashlib
import struct
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

MAX_BODY_BYTES = 8 * 1024 * 1024  # 8 MiB request body limit
MIN_DIMENSION = 1
MAX_DIMENSION = 4096

# color type -> (human readable name, channels per pixel)
SUPPORTED_COLOR_TYPES = {
    0: ("grayscale", 1),
    6: ("rgba", 4),
}


class PngAuditError(Exception):
    """Structured audit failure carrying a stable machine-readable code."""

    def __init__(self, code, message, *, chunk=None, chunk_index=None,
                 offset=None, row=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.chunk = chunk
        self.chunk_index = chunk_index
        self.offset = offset
        self.row = row

    def to_dict(self):
        error = {"code": self.code, "message": self.message}
        if self.chunk is not None:
            error["chunk"] = self.chunk
        if self.chunk_index is not None:
            error["chunk_index"] = self.chunk_index
        if self.offset is not None:
            error["offset"] = self.offset
        if self.row is not None:
            error["row"] = self.row
        return error


def _iter_chunks(data):
    """Yield (index, offset, name, payload) for each structurally valid chunk.

    Raises PngAuditError on truncated headers/payloads, invalid chunk type
    bytes and CRC mismatches, always pointing at the first failing chunk.
    """
    pos = len(PNG_SIGNATURE)
    index = 0
    total = len(data)
    while pos < total:
        if pos + 8 > total:
            raise PngAuditError(
                "TRUNCATED_CHUNK",
                "chunk header truncated: %d byte(s) left, need 8" % (total - pos),
                chunk_index=index, offset=pos)
        length = struct.unpack_from(">I", data, pos)[0]
        raw_type = data[pos + 4:pos + 8]
        try:
            name = raw_type.decode("ascii")
        except UnicodeDecodeError:
            raise PngAuditError(
                "BAD_CHUNK_TYPE",
                "chunk type contains non-ASCII bytes",
                chunk_index=index, offset=pos)
        if not name.isalpha():
            raise PngAuditError(
                "BAD_CHUNK_TYPE",
                "chunk type %r must be ASCII letters only" % name,
                chunk=name, chunk_index=index, offset=pos)
        if pos + 12 + length > total:
            raise PngAuditError(
                "TRUNCATED_CHUNK",
                "chunk %s declares %d data byte(s) but only %d remain"
                % (name, length, total - pos - 8),
                chunk=name, chunk_index=index, offset=pos)
        payload = data[pos + 8:pos + 8 + length]
        crc_stored = struct.unpack_from(">I", data, pos + 8 + length)[0]
        crc_actual = zlib.crc32(payload, zlib.crc32(raw_type)) & 0xFFFFFFFF
        if crc_actual != crc_stored:
            raise PngAuditError(
                "BAD_CRC",
                "CRC mismatch in chunk %s: stored 0x%08x, computed 0x%08x"
                % (name, crc_stored, crc_actual),
                chunk=name, chunk_index=index, offset=pos)
        yield index, pos, name, payload
        pos += 12 + length
        index += 1


def _parse_ihdr(payload, index, offset):
    if len(payload) != 13:
        raise PngAuditError(
            "BAD_CHUNK_LENGTH",
            "IHDR payload must be 13 bytes, got %d" % len(payload),
            chunk="IHDR", chunk_index=index, offset=offset)
    (width, height, bit_depth, color_type,
     compression, filter_method, interlace) = struct.unpack(">IIBBBBB", payload)
    if not (MIN_DIMENSION <= width <= MAX_DIMENSION
            and MIN_DIMENSION <= height <= MAX_DIMENSION):
        raise PngAuditError(
            "DIMENSION_OUT_OF_RANGE",
            "width and height must be within %d..%d, got %dx%d"
            % (MIN_DIMENSION, MAX_DIMENSION, width, height),
            chunk="IHDR", chunk_index=index, offset=offset)
    if bit_depth != 8:
        raise PngAuditError(
            "UNSUPPORTED_BIT_DEPTH",
            "bit depth must be 8, got %d" % bit_depth,
            chunk="IHDR", chunk_index=index, offset=offset)
    if color_type not in SUPPORTED_COLOR_TYPES:
        raise PngAuditError(
            "UNSUPPORTED_COLOR_TYPE",
            "color type must be 0 (grayscale) or 6 (RGBA), got %d" % color_type,
            chunk="IHDR", chunk_index=index, offset=offset)
    if compression != 0:
        raise PngAuditError(
            "UNSUPPORTED_COMPRESSION",
            "compression method must be 0 (deflate), got %d" % compression,
            chunk="IHDR", chunk_index=index, offset=offset)
    if filter_method != 0:
        raise PngAuditError(
            "UNSUPPORTED_FILTER_METHOD",
            "filter method must be 0 (adaptive), got %d" % filter_method,
            chunk="IHDR", chunk_index=index, offset=offset)
    if interlace != 0:
        raise PngAuditError(
            "UNSUPPORTED_INTERLACE",
            "interlace method must be 0 (none), got %d" % interlace,
            chunk="IHDR", chunk_index=index, offset=offset)
    return width, height, color_type


def _inflate(idat_parts, expected):
    """Inflate the joined IDAT stream; it must yield exactly `expected` bytes."""
    compressed = b"".join(idat_parts)
    decompressor = zlib.decompressobj()
    try:
        raw = decompressor.decompress(compressed, expected + 1)
        if decompressor.unconsumed_tail:
            # Output cap reached while compressed input remains.
            raise PngAuditError(
                "DECOMPRESS_OVERFLOW",
                "decompressed data exceeds the %d expected scanline bytes"
                % expected,
                chunk="IDAT")
        raw += decompressor.flush()
    except zlib.error as exc:
        raise PngAuditError(
            "ZLIB_ERROR", "invalid deflate stream in IDAT: %s" % exc,
            chunk="IDAT")
    if len(raw) > expected:
        raise PngAuditError(
            "DECOMPRESS_OVERFLOW",
            "decompressed %d byte(s), expected exactly %d" % (len(raw), expected),
            chunk="IDAT")
    if len(raw) < expected:
        raise PngAuditError(
            "SCANLINE_TRUNCATED",
            "decompressed data covers %d of %d expected scanline bytes"
            % (len(raw), expected),
            chunk="IDAT")
    if not decompressor.eof:
        raise PngAuditError(
            "ZLIB_ERROR",
            "compressed stream ended before the zlib trailer",
            chunk="IDAT")
    if decompressor.unused_data:
        raise PngAuditError(
            "IDAT_TRAILING_DATA",
            "%d compressed byte(s) follow the zlib stream end"
            % len(decompressor.unused_data),
            chunk="IDAT")
    return raw


def _paeth(a, b, c):
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _unfilter_and_hash(raw, width, height, channels):
    """Reverse the per-scanline filters and hash the reconstructed bytes."""
    stride = width * channels
    hasher = hashlib.sha256()
    prev = bytearray(stride)
    pos = 0
    for row in range(height):
        filter_type = raw[pos]
        line = bytearray(raw[pos + 1:pos + 1 + stride])
        pos += stride + 1
        if filter_type == 0:  # None
            pass
        elif filter_type == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif filter_type == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif filter_type == 3:  # Average
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif filter_type == 4:  # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                line[i] = (line[i] + _paeth(a, b, c)) & 0xFF
        else:
            raise PngAuditError(
                "BAD_FILTER_TYPE",
                "scanline %d uses unknown filter type %d" % (row, filter_type),
                row=row)
        hasher.update(line)
        prev = line
    return hasher.hexdigest()


def audit_png(data):
    """Audit a PNG byte stream and return its metadata plus pixel digest.

    Raises PngAuditError with a stable error code and the first failing
    chunk or scanline whenever the stream violates the strict policy.
    """
    if not data.startswith(PNG_SIGNATURE):
        raise PngAuditError(
            "BAD_SIGNATURE",
            "missing or invalid 8-byte PNG signature",
            offset=0)

    ihdr = None
    seen_plte = False
    idat_started = False
    idat_ended = False
    idat_parts = []
    saw_iend = False

    for index, offset, name, payload in _iter_chunks(data):
        if index == 0 and name != "IHDR":
            raise PngAuditError(
                "MISSING_IHDR",
                "first chunk must be IHDR, got %s" % name,
                chunk=name, chunk_index=index, offset=offset)
        if name == "IHDR":
            if ihdr is not None:
                raise PngAuditError(
                    "DUPLICATE_CHUNK", "duplicate IHDR chunk",
                    chunk=name, chunk_index=index, offset=offset)
            ihdr = _parse_ihdr(payload, index, offset)
        elif name == "PLTE":
            if idat_started:
                raise PngAuditError(
                    "BAD_CHUNK_ORDER", "PLTE must appear before IDAT",
                    chunk=name, chunk_index=index, offset=offset)
            if seen_plte:
                raise PngAuditError(
                    "DUPLICATE_CHUNK", "duplicate PLTE chunk",
                    chunk=name, chunk_index=index, offset=offset)
            seen_plte = True
        elif name == "IDAT":
            if idat_ended:
                raise PngAuditError(
                    "NON_CONSECUTIVE_IDAT",
                    "IDAT chunks must be consecutive",
                    chunk=name, chunk_index=index, offset=offset)
            idat_started = True
            idat_parts.append(payload)
        elif name == "IEND":
            if len(payload) != 0:
                raise PngAuditError(
                    "BAD_CHUNK_LENGTH",
                    "IEND payload must be empty, got %d byte(s)" % len(payload),
                    chunk=name, chunk_index=index, offset=offset)
            if not idat_started:
                raise PngAuditError(
                    "MISSING_IDAT", "no IDAT chunk present before IEND",
                    chunk=name, chunk_index=index, offset=offset)
            saw_iend = True
            end = offset + 12
            if end != len(data):
                raise PngAuditError(
                    "TRAILING_BYTES",
                    "%d trailing byte(s) after IEND" % (len(data) - end),
                    chunk=name, chunk_index=index, offset=end)
            break
        else:
            if name[0].isupper():
                raise PngAuditError(
                    "UNKNOWN_CRITICAL_CHUNK",
                    "unsupported critical chunk %s" % name,
                    chunk=name, chunk_index=index, offset=offset)
            # Ancillary chunks are ignored but still terminate the IDAT run.
            if idat_started and not idat_ended:
                idat_ended = True

    if not saw_iend:
        raise PngAuditError(
            "MISSING_IEND", "stream ended without an IEND chunk",
            offset=len(data))

    width, height, color_type = ihdr
    color_name, channels = SUPPORTED_COLOR_TYPES[color_type]
    stride = width * channels
    raw = _inflate(idat_parts, height * (stride + 1))
    digest = _unfilter_and_hash(raw, width, height, channels)

    return {
        "ok": True,
        "width": width,
        "height": height,
        "color_type": color_type,
        "color_type_name": color_name,
        "pixel_bytes": width * height * channels,
        "sha256": digest,
    }
