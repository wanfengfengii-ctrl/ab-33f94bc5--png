"""Unit tests for the strict PNG auditor core."""

from __future__ import annotations

import hashlib
import struct
import unittest
import zlib

from app.pngaudit import PngAuditError, audit_png
from tests.pngsamples import (PNG_SIGNATURE, build_png, chunk,
                              filtered_scanlines, ihdr, random_rows)


def expected_digest(rows):
    return hashlib.sha256(b"".join(rows)).hexdigest()


class ValidImageTests(unittest.TestCase):
    def test_grayscale_all_filters(self):
        rows = random_rows(16, 10, 0, seed=1)
        filters = [i % 5 for i in range(10)]
        png = build_png(16, 10, 0, rows, filters)
        result = audit_png(png)
        self.assertTrue(result["ok"])
        self.assertEqual(result["width"], 16)
        self.assertEqual(result["height"], 10)
        self.assertEqual(result["color_type"], 0)
        self.assertEqual(result["color_type_name"], "grayscale")
        self.assertEqual(result["pixel_bytes"], 160)
        self.assertEqual(result["sha256"], expected_digest(rows))

    def test_rgba_all_filters(self):
        rows = random_rows(9, 13, 6, seed=2)
        filters = [(i * 7 + 1) % 5 for i in range(13)]
        png = build_png(9, 13, 6, rows, filters)
        result = audit_png(png)
        self.assertTrue(result["ok"])
        self.assertEqual(result["color_type"], 6)
        self.assertEqual(result["color_type_name"], "rgba")
        self.assertEqual(result["pixel_bytes"], 9 * 13 * 4)
        self.assertEqual(result["sha256"], expected_digest(rows))

    def test_single_pixel(self):
        rows = random_rows(1, 1, 6, seed=3)
        png = build_png(1, 1, 6, rows, [0])
        result = audit_png(png)
        self.assertEqual(result["pixel_bytes"], 4)
        self.assertEqual(result["sha256"], expected_digest(rows))

    def test_max_dimension_boundary_accepted(self):
        # 4096x1 grayscale stays tiny while exercising the upper bound.
        rows = random_rows(4096, 1, 0, seed=4)
        png = build_png(4096, 1, 0, rows, [2])
        result = audit_png(png)
        self.assertEqual(result["width"], 4096)
        self.assertEqual(result["pixel_bytes"], 4096)

    def test_split_idat_chunks(self):
        rows = random_rows(8, 8, 6, seed=5)
        png = build_png(8, 8, 6, rows, [0] * 8, idat_split=5)
        result = audit_png(png)
        self.assertEqual(result["sha256"], expected_digest(rows))

    def test_ancillary_chunks_ignored(self):
        rows = random_rows(4, 4, 0, seed=6)
        png = build_png(4, 4, 0, rows, [0] * 4, extra_chunks=[
            (b"tEXt", b"Title\x00microscopy", "pre_idat"),
            (b"pHYs", struct.pack(">IIB", 2835, 2835, 1), "pre_idat"),
            (b"tIME", struct.pack(">HBBBBB", 2026, 10, 7, 1, 2, 3),
             "post_idat"),
        ])
        result = audit_png(png)
        self.assertTrue(result["ok"])

    def test_plte_allowed_before_idat(self):
        rows = random_rows(4, 4, 6, seed=7)
        png = build_png(4, 4, 6, rows, [0] * 4, extra_chunks=[
            (b"PLTE", bytes(range(48)), "pre_idat"),
        ])
        self.assertTrue(audit_png(png)["ok"])


class StructuralErrorTests(unittest.TestCase):
    def assert_audit_error(self, png, code, **fields):
        with self.assertRaises(PngAuditError) as ctx:
            audit_png(png)
        error = ctx.exception
        self.assertEqual(error.code, code)
        for key, value in fields.items():
            self.assertEqual(getattr(error, key), value)
        return error

    def test_bad_signature(self):
        self.assert_audit_error(b"not a png at all", "BAD_SIGNATURE")

    def test_empty_body(self):
        self.assert_audit_error(b"", "BAD_SIGNATURE")

    def test_first_chunk_not_ihdr(self):
        png = PNG_SIGNATURE + chunk(b"tEXt", b"a\x00b")
        self.assert_audit_error(png, "MISSING_IHDR", chunk="tEXt",
                                chunk_index=0)

    def test_truncated_chunk_header(self):
        png = PNG_SIGNATURE + ihdr(1, 1) + b"\x00\x00\x00"
        self.assert_audit_error(png, "TRUNCATED_CHUNK", chunk_index=1)

    def test_truncated_chunk_payload(self):
        good = build_png(1, 1, 0, random_rows(1, 1, 0, seed=8), [0])
        self.assert_audit_error(good[:-7], "TRUNCATED_CHUNK")

    def test_bad_crc_reports_chunk(self):
        png = bytearray(build_png(2, 2, 6, random_rows(2, 2, 6, seed=9),
                                  [0, 0]))
        # Flip a byte inside the IDAT payload without fixing its CRC.
        idat_at = png.find(b"IDAT") + 4
        png[idat_at] ^= 0xFF
        self.assert_audit_error(bytes(png), "BAD_CRC", chunk="IDAT")

    def test_bad_chunk_type_bytes(self):
        png = PNG_SIGNATURE + chunk(b"IH1R", b"\x00" * 13)
        self.assert_audit_error(png, "BAD_CHUNK_TYPE")

    def test_ihdr_bad_length(self):
        png = PNG_SIGNATURE + chunk(b"IHDR", b"\x00" * 12)
        self.assert_audit_error(png, "BAD_CHUNK_LENGTH", chunk="IHDR")

    def test_duplicate_ihdr(self):
        png = PNG_SIGNATURE + ihdr(1, 1) + ihdr(1, 1)
        self.assert_audit_error(png, "DUPLICATE_CHUNK", chunk="IHDR")

    def test_unsupported_bit_depth(self):
        png = PNG_SIGNATURE + ihdr(1, 1, bit_depth=16)
        self.assert_audit_error(png, "UNSUPPORTED_BIT_DEPTH")

    def test_unsupported_color_type_rgb(self):
        png = PNG_SIGNATURE + ihdr(1, 1, color_type=2)
        self.assert_audit_error(png, "UNSUPPORTED_COLOR_TYPE")

    def test_unsupported_color_type_palette(self):
        png = PNG_SIGNATURE + ihdr(1, 1, color_type=3)
        self.assert_audit_error(png, "UNSUPPORTED_COLOR_TYPE")

    def test_unsupported_interlace(self):
        png = PNG_SIGNATURE + ihdr(1, 1, interlace=1)
        self.assert_audit_error(png, "UNSUPPORTED_INTERLACE")

    def test_unsupported_compression(self):
        png = PNG_SIGNATURE + ihdr(1, 1, compression=1)
        self.assert_audit_error(png, "UNSUPPORTED_COMPRESSION")

    def test_unsupported_filter_method(self):
        png = PNG_SIGNATURE + ihdr(1, 1, filter_method=1)
        self.assert_audit_error(png, "UNSUPPORTED_FILTER_METHOD")

    def test_zero_dimensions(self):
        self.assert_audit_error(PNG_SIGNATURE + ihdr(0, 1),
                                "DIMENSION_OUT_OF_RANGE")
        self.assert_audit_error(PNG_SIGNATURE + ihdr(1, 0),
                                "DIMENSION_OUT_OF_RANGE")

    def test_oversized_dimensions(self):
        self.assert_audit_error(PNG_SIGNATURE + ihdr(4097, 1),
                                "DIMENSION_OUT_OF_RANGE")
        self.assert_audit_error(PNG_SIGNATURE + ihdr(1, 4097),
                                "DIMENSION_OUT_OF_RANGE")

    def test_unknown_critical_chunk(self):
        rows = random_rows(2, 2, 0, seed=10)
        # "ABCD" has an uppercase first letter, i.e. the critical bit is
        # clear, and it is not one of IHDR/PLTE/IDAT/IEND.
        png = build_png(2, 2, 0, rows, [0, 0], extra_chunks=[
            (b"ABCD", b"\x00" * 8, "pre_idat"),
        ])
        self.assert_audit_error(png, "UNKNOWN_CRITICAL_CHUNK", chunk="ABCD")

    def test_trailing_bytes_after_iend(self):
        rows = random_rows(2, 2, 0, seed=11)
        png = build_png(2, 2, 0, rows, [0, 0]) + b"\x00"
        self.assert_audit_error(png, "TRAILING_BYTES", chunk="IEND")

    def test_missing_iend(self):
        rows = random_rows(2, 2, 0, seed=12)
        png = build_png(2, 2, 0, rows, [0, 0])[:-12]
        self.assert_audit_error(png, "MISSING_IEND")

    def test_missing_idat(self):
        png = PNG_SIGNATURE + ihdr(1, 1) + chunk(b"IEND", b"")
        self.assert_audit_error(png, "MISSING_IDAT")

    def test_non_consecutive_idat(self):
        rows = random_rows(3, 3, 0, seed=13)
        raw = filtered_scanlines(rows, [0, 0, 0], 0)
        compressed = zlib.compress(raw, 9)
        half = len(compressed) // 2
        png = (PNG_SIGNATURE + ihdr(3, 3, color_type=0)
               + chunk(b"IDAT", compressed[:half])
               + chunk(b"tEXt", b"a\x00b")
               + chunk(b"IDAT", compressed[half:])
               + chunk(b"IEND", b""))
        self.assert_audit_error(png, "NON_CONSECUTIVE_IDAT", chunk="IDAT")

    def test_plte_after_idat(self):
        rows = random_rows(2, 2, 6, seed=14)
        png = build_png(2, 2, 6, rows, [0, 0], extra_chunks=[
            (b"PLTE", bytes(range(48)), "post_idat"),
        ])
        self.assert_audit_error(png, "BAD_CHUNK_ORDER", chunk="PLTE")

    def test_iend_with_payload(self):
        png = PNG_SIGNATURE + ihdr(1, 1) + chunk(b"IEND", b"\x00")
        self.assert_audit_error(png, "BAD_CHUNK_LENGTH", chunk="IEND")


class StreamErrorTests(unittest.TestCase):
    def assert_audit_error(self, png, code, **fields):
        with self.assertRaises(PngAuditError) as ctx:
            audit_png(png)
        error = ctx.exception
        self.assertEqual(error.code, code)
        for key, value in fields.items():
            self.assertEqual(getattr(error, key), value)
        return error

    def test_decompress_overflow(self):
        rows = random_rows(4, 4, 0, seed=15)
        raw = filtered_scanlines(rows, [0] * 4, 0)
        extra = filtered_scanlines(rows, [0] * 4, 0)  # second image's worth
        png = build_png(4, 4, 0, rows, [0] * 4, raw_override=raw + extra)
        self.assert_audit_error(png, "DECOMPRESS_OVERFLOW", chunk="IDAT")

    def test_scanline_truncated(self):
        rows = random_rows(4, 4, 0, seed=16)
        raw = filtered_scanlines(rows, [0] * 4, 0)
        png = build_png(4, 4, 0, rows, [0] * 4, raw_override=raw[:-3])
        self.assert_audit_error(png, "SCANLINE_TRUNCATED", chunk="IDAT")

    def test_zlib_garbage(self):
        png = (PNG_SIGNATURE + ihdr(2, 2, color_type=0)
               + chunk(b"IDAT", b"\xde\xad\xbe\xef")
               + chunk(b"IEND", b""))
        self.assert_audit_error(png, "ZLIB_ERROR", chunk="IDAT")

    def test_bad_filter_type_reports_row(self):
        rows = random_rows(5, 6, 0, seed=17)
        raw = bytearray(filtered_scanlines(rows, [0] * 6, 0))
        stride = 5 + 1
        raw[3 * stride] = 5  # row 3 claims filter type 5
        png = build_png(5, 6, 0, rows, [0] * 6, raw_override=bytes(raw))
        self.assert_audit_error(png, "BAD_FILTER_TYPE", row=3)

    def test_bad_filter_type_first_row(self):
        rows = random_rows(3, 2, 6, seed=18)
        raw = bytearray(filtered_scanlines(rows, [0, 0], 6))
        raw[0] = 255
        png = build_png(3, 2, 6, rows, [0, 0], raw_override=bytes(raw))
        self.assert_audit_error(png, "BAD_FILTER_TYPE", row=0)


if __name__ == "__main__":
    unittest.main()
