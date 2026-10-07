// Minimal PNG encoder / mutator fixtures for tests and smoke checks.
// Only used by the test-suite, never by the service itself.

import zlib from 'node:zlib';
import crypto from 'node:crypto';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1');
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 8 + data.length);
  return out;
}

export const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function ihdr({
  width, height, bitDepth = 8, colorType = 0,
  compression = 0, filter = 0, interlace = 0,
}) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = bitDepth;
  d[9] = colorType;
  d[10] = compression;
  d[11] = filter;
  d[12] = interlace;
  return chunk('IHDR', d);
}

// Apply a PNG encoder filter to raw pixel rows.
export function encodeRows(pixelRows, { channels, filterType = 0 }) {
  const bpp = channels;
  const stride = pixelRows[0].length;
  const out = Buffer.alloc(pixelRows.length * (stride + 1));
  let prev = null;
  pixelRows.forEach((row, y) => {
    const start = y * (stride + 1);
    out[start] = filterType;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let f;
      switch (filterType) {
        case 0: f = row[i]; break;
        case 1: f = (row[i] - a) & 0xff; break;
        case 2: f = (row[i] - b) & 0xff; break;
        case 3: f = (row[i] - ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          f = (row[i] - pred) & 0xff;
          break;
        }
        default: throw new Error(`bad fixture filter ${filterType}`);
      }
      out[start + 1 + i] = f;
    }
    prev = row;
  });
  return out;
}

/**
 * Build a complete PNG. Options:
 *   width,height,colorType (0|6), filterType, idatSplits (chunk count),
 *   extraChunks (array inserted between IHDR and IDAT),
 *   chunksAfterIdat (array inserted between IDAT and IEND),
 *   rawOverride / compressedOverride, trailing.
 */
export function buildPng(opts = {}) {
  const {
    width = 8,
    height = 4,
    colorType = 0,
    bitDepth = 8,
    interlace = 0,
    filterType = 0,
    idatSplits = 1,
    extraChunks = [],
    chunksAfterIdat = [],
    rawOverride = null,
    compressedOverride = null,
    trailing = null,
  } = opts;

  const channels = colorType === 6 ? 4 : 1;
  const stride = width * channels;
  let pixels = opts.pixels;
  if (!pixels) {
    pixels = Array.from({ length: height }, (_, y) =>
      Buffer.from(Array.from({ length: stride }, (_, x) => (x * 31 + y * 17) & 0xff)));
  }

  const raw = rawOverride || encodeRows(pixels, { channels, filterType });
  const expectedRawLength = height * (stride + 1);
  if (rawOverride === null && raw.length !== expectedRawLength) {
    throw new Error('fixture raw length mismatch');
  }
  const compressed = compressedOverride || zlib.deflateSync(raw);

  const parts = [
    SIGNATURE,
    ihdr({ width, height, bitDepth, colorType, interlace }),
    ...extraChunks,
  ];
  const pieceLen = Math.ceil(compressed.length / idatSplits);
  for (let i = 0; i < idatSplits; i++) {
    parts.push(chunk('IDAT', compressed.subarray(i * pieceLen, (i + 1) * pieceLen)));
  }
  parts.push(...chunksAfterIdat);
  parts.push(chunk('IEND', Buffer.alloc(0)));
  let out = Buffer.concat(parts);
  if (trailing) out = Buffer.concat([out, trailing]);
  return { png: out, pixels, raw, stride, expectedRawLength };
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Deterministic small valid grayscale / RGBA PNGs for smoke tests.
export function validGrayPng(size = 4) {
  const pixels = Array.from({ length: size }, (_, y) =>
    Buffer.from(Array.from({ length: size }, (_, x) => (x * 7 + y * 13) & 0xff)));
  return buildPng({ width: size, height: size, colorType: 0, filterType: 4, pixels });
}

export function validRgbaPng(size = 4) {
  const pixels = Array.from({ length: size }, (_, y) =>
    Buffer.from(Array.from({ length: size * 4 }, (_, i) =>
      (i * 41 + y * 7 + 3) & 0xff)));
  return buildPng({ width: size, height: size, colorType: 6, filterType: 2, pixels });
}
