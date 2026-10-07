// End-to-end HTTP smoke test for POST /api/png/audit.
// Waits for /healthz, then exercises valid and deliberately corrupt PNGs.
// Exits 0 only if every assertion holds; non-zero (with details) otherwise.

import zlib from 'node:zlib';
import {
  buildPng, chunk, SIGNATURE, validGrayPng, validRgbaPng, sha256,
} from './fixtures.js';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8080';
const DEADLINE = Date.now() +
  Number.parseInt(process.env.HEALTH_WAIT_MS || '30000', 10);

let failures = 0;
const check = (cond, label, detail = '') => {
  if (cond) {
    console.log(`  ok - ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${label}${detail ? ` :: ${detail}` : ''}`);
  }
};

async function waitForHealth() {
  for (;;) {
    try {
      const r = await fetch(`${BASE_URL}/healthz`);
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    if (Date.now() > DEADLINE) {
      throw new Error(`service at ${BASE_URL} never became healthy`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function audit(png, { contentType = 'image/png' } = {}) {
  return fetch(`${BASE_URL}/api/png/audit`, {
    method: 'POST',
    headers: contentType ? { 'content-type': contentType } : {},
    body: png,
  });
}

async function run() {
  console.log(`smoke target: ${BASE_URL}`);
  await waitForHealth();
  console.log('service healthy');

  // --- health / routing ---------------------------------------------------
  {
    const r = await fetch(`${BASE_URL}/healthz`);
    check(r.status === 200, 'GET /healthz -> 200');
  }
  {
    const r = await fetch(`${BASE_URL}/api/png/audit`, { method: 'GET' });
    check(r.status === 405, 'GET audit -> 405');
  }
  {
    const r = await fetch(`${BASE_URL}/nope`);
    check(r.status === 404, 'unknown route -> 404');
  }

  // --- valid grayscale -----------------------------------------------------
  {
    const { png, pixels } = validGrayPng(5);
    const r = await audit(png);
    const body = await r.json();
    check(r.status === 200, 'valid grayscale -> 200', JSON.stringify(body));
    check(body.width === 5 && body.height === 5 &&
      body.colorType === 0 && body.pixelBytes === 25,
      'grayscale metadata correct', JSON.stringify(body));
    check(body.sha256 === sha256(Buffer.concat(pixels)),
      'grayscale SHA-256 equals hash of raw channel bytes', body.sha256);
    check(/^[0-9a-f]{64}$/.test(body.sha256), 'sha256 is lowercase hex');
  }

  // --- valid RGBA, every filter family covered by unit tests; use Paeth ----
  {
    const { png, pixels } = validRgbaPng(6);
    const r = await audit(png);
    const body = await r.json();
    check(r.status === 200, 'valid RGBA -> 200', JSON.stringify(body));
    check(body.width === 6 && body.height === 6 &&
      body.colorType === 6 && body.pixelBytes === 144,
      'RGBA metadata correct', JSON.stringify(body));
    check(body.sha256 === sha256(Buffer.concat(pixels)),
      'RGBA SHA-256 equals hash of raw channel bytes');
  }

  // --- valid PNG with IDAT split into 4 consecutive chunks ----------------
  {
    const { png } = buildPng({ width: 10, height: 3, idatSplits: 4, filterType: 3 });
    const r = await audit(png);
    check(r.status === 200, 'multi-IDAT valid PNG -> 200');
  }

  // --- HTTP-level rejection: content type ---------------------------------
  {
    const { png } = validGrayPng();
    const r = await audit(png, { contentType: 'application/octet-stream' });
    const body = await r.json();
    check(r.status === 415 && body.error?.code === 'UNSUPPORTED_MEDIA_TYPE',
      'wrong Content-Type -> 415 UNSUPPORTED_MEDIA_TYPE', JSON.stringify(body));
  }
  {
    const r = await audit(Buffer.alloc(0));
    const body = await r.json();
    check(r.status === 400 && body.error?.code === 'EMPTY_BODY',
      'empty body -> 400 EMPTY_BODY', JSON.stringify(body));
  }

  // --- declared oversized body (Content-Length guard) ---------------------
  {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x89);
    const r = await audit(big);
    const body = await r.json();
    check(r.status === 413 && body.error?.code === 'BODY_TOO_LARGE',
      'oversized body -> 413 BODY_TOO_LARGE', JSON.stringify(body));
  }

  // --- corrupt PNG matrix --------------------------------------------------
  const cases = [
    ['bad signature', () => {
      const { png } = validGrayPng(); png[0] = 0; return png;
    }, 'INVALID_SIGNATURE', {}],
    ['CRC corruption', () => {
      const { png } = validGrayPng(); png[8 + 25 + 8 + 1] ^= 0xff; return png;
    }, 'CRC_MISMATCH', { chunk: 2 }],
    ['trailing bytes after IEND', () =>
      buildPng({ trailing: Buffer.from('xxxx') }).png,
      'TRAILING_BYTES', { chunk: 3 }],
    ['truncated file', () =>
      validGrayPng().png.subarray(0, 40), 'TRUNCATED_CHUNK', {}],
    ['unknown critical chunk', () =>
      buildPng({ extraChunks: [chunk('FAKE', Buffer.from('z'))] }).png,
      'UNKNOWN_CRITICAL_CHUNK', { chunk: 2 }],
    ['non-contiguous IDAT', () => {
      const { raw } = validGrayPng();
      const c = zlib.deflateSync(raw);
      const h = Math.ceil(c.length / 2);
      const ihdrData = Buffer.alloc(13);
      ihdrData.writeUInt32BE(4, 0); ihdrData.writeUInt32BE(4, 4);
      ihdrData[8] = 8; ihdrData[9] = 0;
      return Buffer.concat([
        SIGNATURE, chunk('IHDR', ihdrData),
        chunk('IDAT', c.subarray(0, h)),
        chunk('tEXt', Buffer.from('a\x00b')),
        chunk('IDAT', c.subarray(h)),
        chunk('IEND', Buffer.alloc(0)),
      ]);
    }, 'NONCONTIGUOUS_IDAT', { chunk: 4 }],
    ['Adam7 interlaced', () =>
      buildPng({ interlace: 1 }).png, 'INTERLACED_UNSUPPORTED', { chunk: 1 }],
    ['16-bit grayscale', () =>
      buildPng({ bitDepth: 16 }).png, 'UNSUPPORTED_BIT_DEPTH', { chunk: 1 }],
    ['RGB color type 2', () =>
      buildPng({ colorType: 2 }).png, 'UNSUPPORTED_COLOR_TYPE', { chunk: 1 }],
    ['4097 width', () => {
      const raw = Buffer.alloc(2 * (1 + 1));
      return buildPng({
        width: 4097, height: 1, rawOverride: raw,
      }).png;
    }, 'INVALID_DIMENSIONS', { chunk: 1 }],
    ['junk after zlib stream', () => {
      const { raw } = validGrayPng();
      return buildPng({
        compressedOverride: Buffer.concat([
          zlib.deflateSync(raw), Buffer.from('JUNK'),
        ]),
      }).png;
    }, 'ZLIB_TRAILING_BYTES', {}],
    ['decompressed overrun', () =>
      buildPng({
        width: 4, height: 4,
        rawOverride: Buffer.alloc(4 * 5 + 2, 0),
      }).png, 'OUT_OF_BOUNDS_DECOMPRESSED_DATA', {}],
    ['truncated scanline 4', () =>
      buildPng({
        width: 4, height: 4,
        rawOverride: Buffer.alloc(4 * 5 - 1, 0),
      }).png, 'TRUNCATED_SCANLINE', { line: 4 }],
    ['invalid filter on line 2', () => {
      const stride = 4;
      const raw = Buffer.alloc(4 * (stride + 1), 0);
      raw[(stride + 1) * 1] = 9;
      return buildPng({ width: 4, height: 4, rawOverride: raw }).png;
    }, 'INVALID_FILTER_TYPE', { line: 2 }],
  ];

  for (const [label, make, code, loc] of cases) {
    const r = await audit(make());
    const body = await r.json().catch(() => null);
    check(r.status === 422 && body?.error?.code === code,
      `corrupt [${label}] -> 422 ${code}`,
      `got ${r.status} ${JSON.stringify(body?.error)}`);
    if (loc.chunk !== undefined) {
      check(body?.error?.chunk === loc.chunk,
        `corrupt [${label}] reports chunk ${loc.chunk}`,
        `got chunk=${body?.error?.chunk}`);
    }
    if (loc.line !== undefined) {
      check(body?.error?.line === loc.line,
        `corrupt [${label}] reports line ${loc.line}`,
        `got line=${body?.error?.line}`);
    }
  }

  // --- error stability: identical corrupt input yields identical code ----
  {
    const make = () => { const { png } = validGrayPng(); png[10] ^= 0xff; return png; };
    const [a, b] = await Promise.all([audit(make()), audit(make())]);
    const ba = await a.json(); const bb = await b.json();
    check(a.status === b.status && ba.error.code === bb.error.code &&
      ba.error.chunk === bb.error.chunk,
      'stable error code and location across requests',
      `${JSON.stringify(ba.error)} vs ${JSON.stringify(bb.error)}`);
  }

  console.log(failures === 0
    ? '\nSMOKE PASSED'
    : `\nSMOKE FAILED: ${failures} assertion(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run().catch((err) => {
  console.error('smoke harness error:', err);
  process.exit(1);
});
