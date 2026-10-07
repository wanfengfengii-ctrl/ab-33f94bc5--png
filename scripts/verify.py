#!/usr/bin/env python3
"""One-shot verification service.

Waits for the API to become healthy, then runs the build check
(byte-compilation), the unit test suite, and HTTP smoke tests with valid
and corrupted PNGs. Exits 0 when everything passes, 1 otherwise so the
Compose `verify` service reports the outcome through its exit code.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from app.pngaudit import MAX_BODY_BYTES  # noqa: E402
from tests.pngsamples import (PNG_SIGNATURE, build_png, chunk,  # noqa: E402
                              filtered_scanlines, ihdr, random_rows)

API_URL = os.environ.get("API_URL", "http://127.0.0.1:8000").rstrip("/")

FAILURES = []


def step(title):
    print("\n=== %s ===" % title, flush=True)


def run(cmd):
    print("+ %s" % " ".join(cmd), flush=True)
    return subprocess.run(cmd, cwd=ROOT).returncode


def check(name, condition, detail=""):
    if condition:
        print("PASS  %s" % name, flush=True)
    else:
        print("FAIL  %s  %s" % (name, detail), flush=True)
        FAILURES.append(name)


def wait_for_health(timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(API_URL + "/health",
                                        timeout=3) as response:
                if response.status == 200:
                    print("API healthy at %s" % API_URL, flush=True)
                    return True
        except (urllib.error.URLError, OSError):
            time.sleep(1)
    print("API did not become healthy within %ds" % timeout, flush=True)
    return False


def post_audit(body, content_type="image/png"):
    request = urllib.request.Request(
        API_URL + "/api/png/audit", data=body,
        headers={"Content-Type": content_type}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def expect_error(name, png, code):
    status, payload = post_audit(png)
    error = payload.get("error", {})
    check(name, status == 400 and error.get("code") == code,
          "status=%s payload=%s" % (status, payload))
    return error


def smoke_tests():
    step("HTTP smoke tests")

    # -- valid grayscale, every filter type in rotation -----------------
    rows = random_rows(17, 12, 0, seed=101)
    filters = [i % 5 for i in range(12)]
    status, payload = post_audit(build_png(17, 12, 0, rows, filters))
    check("valid grayscale accepted", status == 200
          and payload.get("ok") is True
          and payload.get("width") == 17
          and payload.get("height") == 12
          and payload.get("color_type") == 0
          and payload.get("pixel_bytes") == 17 * 12
          and payload.get("sha256")
          == hashlib.sha256(b"".join(rows)).hexdigest(),
          "status=%s payload=%s" % (status, payload))

    # -- valid RGBA, split IDAT, ancillary chunks -----------------------
    rows = random_rows(11, 9, 6, seed=102)
    png = build_png(11, 9, 6, rows, [(i * 3) % 5 for i in range(9)],
                    idat_split=4,
                    extra_chunks=[(b"tEXt", b"Source\x00scope-7", "pre_idat")])
    status, payload = post_audit(png)
    check("valid rgba accepted", status == 200
          and payload.get("ok") is True
          and payload.get("color_type") == 6
          and payload.get("pixel_bytes") == 11 * 9 * 4
          and payload.get("sha256")
          == hashlib.sha256(b"".join(rows)).hexdigest(),
          "status=%s payload=%s" % (status, payload))

    # -- corrupted samples ----------------------------------------------
    expect_error("empty chunk stream rejected", b"\x89PNG\r\n\x1a\n",
                 "MISSING_IEND")
    expect_error("not a png rejected", b"hello world", "BAD_SIGNATURE")

    corrupt = bytearray(build_png(4, 4, 0, random_rows(4, 4, 0, seed=103),
                                  [0] * 4))
    corrupt[corrupt.find(b"IDAT") + 6] ^= 0xFF
    expect_error("crc mismatch rejected", bytes(corrupt), "BAD_CRC")

    rows = random_rows(4, 4, 0, seed=104)
    expect_error("unknown critical chunk rejected",
                 build_png(4, 4, 0, rows, [0] * 4,
                           extra_chunks=[(b"ABCD", b"\x00" * 4, "pre_idat")]),
                 "UNKNOWN_CRITICAL_CHUNK")

    expect_error("trailing bytes rejected",
                 build_png(4, 4, 0, rows, [0] * 4) + b"\x00",
                 "TRAILING_BYTES")

    raw = filtered_scanlines(rows, [0] * 4, 0)
    expect_error("truncated scanlines rejected",
                 build_png(4, 4, 0, rows, [0] * 4, raw_override=raw[:-2]),
                 "SCANLINE_TRUNCATED")
    expect_error("decompress overflow rejected",
                 build_png(4, 4, 0, rows, [0] * 4, raw_override=raw + raw),
                 "DECOMPRESS_OVERFLOW")

    tampered = bytearray(raw)
    tampered[2 * 5] = 7  # row 2 filter byte
    error = expect_error("bad filter type rejected",
                         build_png(4, 4, 0, rows, [0] * 4,
                                   raw_override=bytes(tampered)),
                         "BAD_FILTER_TYPE")
    check("bad filter reports row", error.get("row") == 2,
          "payload=%s" % error)

    compressed = zlib.compress(raw, 9)
    half = len(compressed) // 2
    png = (PNG_SIGNATURE + ihdr(4, 4, color_type=0)
           + chunk(b"IDAT", compressed[:half])
           + chunk(b"tEXt", b"a\x00b")
           + chunk(b"IDAT", compressed[half:])
           + chunk(b"IEND", b""))
    expect_error("non-consecutive idat rejected", png,
                 "NON_CONSECUTIVE_IDAT")

    expect_error("unsupported color type rejected",
                 PNG_SIGNATURE + ihdr(4, 4, color_type=2),
                 "UNSUPPORTED_COLOR_TYPE")

    # -- protocol-level behaviour ---------------------------------------
    status, payload = post_audit(b"x", content_type="text/plain")
    check("wrong content type rejected", status == 415
          and payload.get("error", {}).get("code")
          == "UNSUPPORTED_MEDIA_TYPE",
          "status=%s payload=%s" % (status, payload))

    status, payload = post_audit(b"\x00" * (MAX_BODY_BYTES + 1))
    check("oversized body rejected", status == 413
          and payload.get("error", {}).get("code") == "PAYLOAD_TOO_LARGE",
          "status=%s payload=%s" % (status, payload))


def main():
    if not wait_for_health():
        return 1

    step("Build (byte-compile all sources)")
    build_ok = run([sys.executable, "-m", "compileall", "-q",
                    "app", "tests", "scripts"]) == 0
    check("byte-compile", build_ok)

    step("Unit tests")
    tests_ok = run([sys.executable, "-m", "unittest", "discover",
                    "-s", "tests", "-v"]) == 0
    check("unit test suite", tests_ok)

    smoke_tests()

    step("Summary")
    if FAILURES:
        print("%d check(s) failed: %s" % (len(FAILURES), ", ".join(FAILURES)),
              flush=True)
        return 1
    print("all checks passed", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
