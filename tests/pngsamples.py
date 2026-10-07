"""Helpers to build well-formed and deliberately corrupted PNG samples.

Shared by the unit tests and the verify service's HTTP smoke tests so both
exercise exactly the same fixtures. Includes forward encoders for all five
standard scanline filters, which makes round-trip verification of the
auditor's unfiltering possible.
"""

from __future__ import annotations

import random
import struct
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

CHANNELS = {0: 1, 6: 4}


def chunk(name, payload):
    """Build a length/type/payload/CRC chunk with a correct CRC."""
    return (struct.pack(">I", len(payload)) + name + payload
            + struct.pack(">I", zlib.crc32(payload, zlib.crc32(name))
                          & 0xFFFFFFFF))


def ihdr(width, height, bit_depth=8, color_type=6, compression=0,
         filter_method=0, interlace=0):
    return chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, bit_depth,
                                      color_type, compression, filter_method,
                                      interlace))


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def apply_filter(filter_type, row, prev, bpp):
    """Forward-filter one scanline; inverse of the auditor's unfiltering."""
    out = bytearray(len(row))
    if filter_type == 0:
        out[:] = row
    elif filter_type == 1:
        for i in range(len(row)):
            left = row[i - bpp] if i >= bpp else 0
            out[i] = (row[i] - left) & 0xFF
    elif filter_type == 2:
        for i in range(len(row)):
            out[i] = (row[i] - prev[i]) & 0xFF
    elif filter_type == 3:
        for i in range(len(row)):
            left = row[i - bpp] if i >= bpp else 0
            out[i] = (row[i] - ((left + prev[i]) >> 1)) & 0xFF
    elif filter_type == 4:
        for i in range(len(row)):
            a = row[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            out[i] = (row[i] - paeth(a, b, c)) & 0xFF
    else:
        raise ValueError("unknown filter type %d" % filter_type)
    return bytes([filter_type]) + bytes(out)


def random_rows(width, height, color_type, seed=1234):
    rng = random.Random(seed)
    stride = width * CHANNELS[color_type]
    return [bytes(rng.randrange(256) for _ in range(stride))
            for _ in range(height)]


def filtered_scanlines(rows, filters, color_type):
    """Encode pixel rows with the given per-row filter types."""
    bpp = CHANNELS[color_type]
    raw = bytearray()
    prev = bytes(len(rows[0]))
    for row, filter_type in zip(rows, filters):
        raw += apply_filter(filter_type, row, prev, bpp)
        prev = row
    return bytes(raw)


def build_png(width, height, color_type, rows, filters, idat_split=1,
              extra_chunks=(), ihdr_overrides=None, raw_override=None):
    """Assemble a complete PNG byte string.

    extra_chunks: (name, payload, position) triples where position is
    "pre_idat" or "post_idat". raw_override replaces the filtered scanline
    bytes before compression (used to build truncated/overflowing streams).
    """
    raw = raw_override if raw_override is not None else filtered_scanlines(
        rows, filters, color_type)
    compressed = zlib.compress(raw, 9)
    parts = [PNG_SIGNATURE,
             ihdr(width, height, color_type=color_type,
                  **(ihdr_overrides or {}))]
    for name, payload, position in extra_chunks:
        if position == "pre_idat":
            parts.append(chunk(name, payload))
    if idat_split <= 1:
        parts.append(chunk(b"IDAT", compressed))
    else:
        step = max(1, len(compressed) // idat_split)
        for i in range(0, len(compressed), step):
            parts.append(chunk(b"IDAT", compressed[i:i + step]))
    for name, payload, position in extra_chunks:
        if position == "post_idat":
            parts.append(chunk(name, payload))
    parts.append(chunk(b"IEND", b""))
    return b"".join(parts)
