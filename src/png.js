// Strict PNG validator / auditor.
//
// Parses a PNG byte-for-byte with no decoder tolerance: signature, chunk
// order, chunk lengths, CRC32, IHDR constraints, a single contiguous run of
// IDAT chunks, and zlib stream boundaries are all checked.  The five PNG
// line filters (None/Sub/Up/Average/Paeth) are reconstructed over the raw
// channel bytes and a SHA-256 is computed over the concatenated
// reconstructed scanlines (pixel channel bytes only, one row at a time).
//
// Only 8-bit, non-interlaced grayscale (color type 0) and RGB+alpha
// (color type 6) images are accepted.

import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MiB
const MAX_DIMENSION = 4096;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Critical chunks defined by the PNG specification (ISO/IEC 15948).
const CRITICAL_TYPES = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

// colorType -> channels
const COLOR_SPECS = {
  0: { channels: 1 }, // grayscale
  6: { channels: 4 }, // RGB + alpha
};

const FILTER_NONE = 0;
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_AVERAGE = 3;
const FILTER_PAETH = 4;

/**
 * Error carrying a stable machine-readable code plus, where applicable, the
 * 1-based index of the first failing chunk or scanline.
 */
export class PngAuditError extends Error {
  constructor(code, message, { chunkNumber = null, lineNumber = null } = {}) {
    super(message);
    this.name = 'PngAuditError';
    this.code = code;
    this.chunkNumber = chunkNumber;
    this.lineNumber = lineNumber;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const isAsciiLetter = (ch) =>
  (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122);

/**
 * Audit a PNG buffer.
 * @param {Buffer} buf raw PNG bytes
 * @returns {Promise<{width:number,height:number,colorType:number,
 *   pixelBytes:number,sha256:string}>}
 * @throws {PngAuditError}
 */
export async function auditPng(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new PngAuditError('INVALID_INPUT', 'request body must be a binary PNG payload');
  }
  if (buf.length === 0) {
    throw new PngAuditError('EMPTY_BODY', 'empty request body');
  }
  if (buf.length > MAX_BODY_BYTES) {
    throw new PngAuditError('BODY_TOO_LARGE',
      `body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  // ---- 1. Signature ------------------------------------------------------
  if (buf.length < PNG_SIGNATURE.length || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PngAuditError('INVALID_SIGNATURE', 'missing or invalid PNG signature');
  }

  // ---- 2. Chunk walk -----------------------------------------------------
  let offset = PNG_SIGNATURE.length;
  let chunkNumber = 0;
  let ihdr = null;
  const idatChunks = [];
  let sawIDAT = false;        // an IDAT has appeared
  let idatClosed = false;     // a different chunk appeared after the IDAT run
  let sawIEND = false;

  while (offset < buf.length) {
    if (buf.length - offset < 8) {
      throw new PngAuditError('TRUNCATED_CHUNK',
        'truncated chunk header', { chunkNumber: chunkNumber + 1 });
    }
    const dataLength = buf.readUInt32BE(offset);
    const typeStart = offset + 4;
    const type = buf.toString('latin1', typeStart, typeStart + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + dataLength;
    if (dataEnd + 4 > buf.length) {
      throw new PngAuditError('TRUNCATED_CHUNK',
        `chunk ${JSON.stringify(type)} length ${dataLength} exceeds remaining bytes`,
        { chunkNumber: chunkNumber + 1 });
    }

    // CRC covers type bytes + data.
    const expectedCrc = buf.readUInt32BE(dataEnd);
    const actualCrc = crc32(buf.subarray(typeStart, dataEnd));
    if (actualCrc !== expectedCrc) {
      throw new PngAuditError('CRC_MISMATCH',
        `CRC check failed in chunk ${type}`,
        { chunkNumber: chunkNumber + 1 });
    }

    const data = buf.subarray(dataStart, dataEnd);
    chunkNumber += 1;

    for (let i = 0; i < 4; i++) {
      if (!isAsciiLetter(buf[typeStart + i])) {
        throw new PngAuditError('INVALID_CHUNK_TYPE',
          'chunk type contains non-letter bytes', { chunkNumber });
      }
    }
    // Bit 5 of the first type byte: uppercase = critical.
    const critical = buf[typeStart] >= 65 && buf[typeStart] <= 90;

    if (critical && !CRITICAL_TYPES.has(type)) {
      throw new PngAuditError('UNKNOWN_CRITICAL_CHUNK',
        `unsupported critical chunk ${type}`, { chunkNumber });
    }

    switch (type) {
      case 'IHDR': {
        if (chunkNumber !== 1) {
          throw new PngAuditError('BAD_CHUNK_ORDER',
            'IHDR must be the first chunk', { chunkNumber });
        }
        if (data.length !== 13) {
          throw new PngAuditError('INVALID_IHDR',
            `IHDR data must be 13 bytes, got ${data.length}`, { chunkNumber });
        }
        const width = data.readUInt32BE(0);
        const height = data.readUInt32BE(4);
        const bitDepth = data[8];
        const colorType = data[9];
        const compressionMethod = data[10];
        const filterMethod = data[11];
        const interlaceMethod = data[12];

        if (width < 1 || width > MAX_DIMENSION) {
          throw new PngAuditError('INVALID_DIMENSIONS',
            `width ${width} outside 1..${MAX_DIMENSION}`, { chunkNumber });
        }
        if (height < 1 || height > MAX_DIMENSION) {
          throw new PngAuditError('INVALID_DIMENSIONS',
            `height ${height} outside 1..${MAX_DIMENSION}`, { chunkNumber });
        }
        if (bitDepth !== 8) {
          throw new PngAuditError('UNSUPPORTED_BIT_DEPTH',
            `only 8-bit images accepted, got bit depth ${bitDepth}`,
            { chunkNumber });
        }
        if (!Object.prototype.hasOwnProperty.call(COLOR_SPECS, colorType)) {
          throw new PngAuditError('UNSUPPORTED_COLOR_TYPE',
            `only grayscale (0) and RGBA (6) accepted, got color type ${colorType}`,
            { chunkNumber });
        }
        if (compressionMethod !== 0) {
          throw new PngAuditError('INVALID_IHDR',
            `unsupported compression method ${compressionMethod}`, { chunkNumber });
        }
        if (filterMethod !== 0) {
          throw new PngAuditError('INVALID_IHDR',
            `unsupported filter method ${filterMethod}`, { chunkNumber });
        }
        if (interlaceMethod !== 0) {
          throw new PngAuditError('INTERLACED_UNSUPPORTED',
            `interlaced images (method ${interlaceMethod}) are not accepted`,
            { chunkNumber });
        }
        ihdr = { width, height, bitDepth, colorType };
        break;
      }

      case 'PLTE':
        // Neither accepted color type permits a palette.
        throw new PngAuditError('UNSUPPORTED_COLOR_TYPE',
          'palette images are not accepted', { chunkNumber });

      case 'IDAT': {
        if (!ihdr) {
          throw new PngAuditError('BAD_CHUNK_ORDER', 'IDAT before IHDR',
            { chunkNumber });
        }
        if (idatClosed) {
          throw new PngAuditError('NONCONTIGUOUS_IDAT',
            'IDAT chunks must be consecutive', { chunkNumber });
        }
        if (sawIEND) {
          throw new PngAuditError('BAD_CHUNK_ORDER', 'IDAT after IEND',
            { chunkNumber });
        }
        sawIDAT = true;
        idatChunks.push(data);
        break;
      }

      case 'IEND': {
        if (!ihdr) {
          throw new PngAuditError('BAD_CHUNK_ORDER', 'IEND before IHDR',
            { chunkNumber });
        }
        if (!sawIDAT) {
          throw new PngAuditError('MISSING_IDAT', 'no IDAT chunk before IEND',
            { chunkNumber });
        }
        if (data.length !== 0) {
          throw new PngAuditError('INVALID_IEND',
            'IEND data field must be empty', { chunkNumber });
        }
        offset = dataEnd + 4;
        if (offset !== buf.length) {
          throw new PngAuditError('TRAILING_BYTES',
            `${buf.length - offset} trailing byte(s) after IEND`,
            { chunkNumber });
        }
        return finalize(ihdr, idatChunks);
      }

      default: {
        // Ancillary chunk (unknown ones are ignored per the PNG spec, but
        // their length and CRC have already been verified).
        if (!ihdr) {
          throw new PngAuditError('BAD_CHUNK_ORDER',
            `ancillary chunk ${type} appears before IHDR`, { chunkNumber });
        }
        if (sawIEND) {
          throw new PngAuditError('BAD_CHUNK_ORDER',
            `chunk ${type} appears after IEND`, { chunkNumber });
        }
        if (sawIDAT) {
          // Any non-IDAT chunk after the run closes it; a later IDAT is
          // rejected above as NONCONTIGUOUS_IDAT.
          idatClosed = true;
        }
        break;
      }
    }

    offset = dataEnd + 4;
  }

  if (!sawIEND) {
    throw new PngAuditError('MISSING_IEND',
      'PNG data ended without an IEND chunk',
      { chunkNumber: chunkNumber + 1 });
  }
  throw new PngAuditError('MALFORMED_PNG', 'unexpected parser state');
}

/**
 * Concatenate the contiguous IDAT payloads, inflate with strict stream
 * boundary checks, undo filters, and hash the reconstructed pixels.
 */
async function finalize(ihdr, idatChunks) {
  const { width, height, colorType } = ihdr;
  const channels = COLOR_SPECS[colorType].channels;
  const bytesPerPixel = channels; // bit depth is exactly 8
  const stride = width * bytesPerPixel;
  const expectedRawLength = height * (stride + 1); // +1 filter byte/line

  const compressed = Buffer.concat(idatChunks);

  let raw;
  try {
    raw = await inflateStrict(compressed, expectedRawLength);
  } catch (err) {
    if (err instanceof PngAuditError) throw err;
    throw new PngAuditError('ZLIB_ERROR',
      `zlib decompression failed: ${err.message}`);
  }

  if (raw.length !== expectedRawLength) {
    if (raw.length > expectedRawLength) {
      // Defensive: inflateStrict already aborts at this boundary.
      throw new PngAuditError('OUT_OF_BOUNDS_DECOMPRESSED_DATA',
        `decompressed data (${raw.length} B) exceeds the ` +
        `${expectedRawLength} B required for ${height} filtered scanline(s)`);
    }
    const completeLines = Math.floor(raw.length / (stride + 1));
    throw new PngAuditError('TRUNCATED_SCANLINE',
      `decompressed data (${raw.length} B) is ` +
      `${expectedRawLength - raw.length} byte(s) short; scanline ` +
      `${completeLines + 1} is truncated`,
      { lineNumber: completeLines + 1 });
  }

  // ---- Undo the five standard per-scanline filters ----------------------
  // Only the immediately preceding reconstructed row is ever referenced,
  // so two row buffers (swapped after each line) bound decoder memory
  // regardless of image height.
  let prevRow = Buffer.allocUnsafe(stride);
  let curRow = Buffer.allocUnsafe(stride);
  const hash = crypto.createHash('sha256');

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filterType = raw[rowStart];
    const src = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const above = y === 0 ? null : prevRow;

    switch (filterType) {
      case FILTER_NONE:
        src.copy(curRow);
        break;
      case FILTER_SUB:
        for (let i = 0; i < stride; i++) {
          const a = i >= bytesPerPixel ? curRow[i - bytesPerPixel] : 0;
          curRow[i] = (src[i] + a) & 0xff;
        }
        break;
      case FILTER_UP:
        for (let i = 0; i < stride; i++) {
          const b = above ? above[i] : 0;
          curRow[i] = (src[i] + b) & 0xff;
        }
        break;
      case FILTER_AVERAGE:
        for (let i = 0; i < stride; i++) {
          const a = i >= bytesPerPixel ? curRow[i - bytesPerPixel] : 0;
          const b = above ? above[i] : 0;
          curRow[i] = (src[i] + ((a + b) >> 1)) & 0xff;
        }
        break;
      case FILTER_PAETH:
        for (let i = 0; i < stride; i++) {
          const a = i >= bytesPerPixel ? curRow[i - bytesPerPixel] : 0;
          const b = above ? above[i] : 0;
          const c = (above && i >= bytesPerPixel)
            ? above[i - bytesPerPixel] : 0;
          curRow[i] = (src[i] + paethPredictor(a, b, c)) & 0xff;
        }
        break;
      default:
        throw new PngAuditError('INVALID_FILTER_TYPE',
          `scanline ${y + 1} uses unknown filter type ${filterType}`,
          { lineNumber: y + 1 });
    }

    // Digest of the raw channel bytes, line by line (no filter prefix).
    hash.update(curRow);
    // This row becomes the prior row; the old prior buffer is reused.
    [prevRow, curRow] = [curRow, prevRow];
  }

  return {
    width,
    height,
    colorType,
    pixelBytes: stride * height,
    sha256: hash.digest('hex'), // lowercase hex
  };
}

/**
 * Inflate the single zlib stream while refusing trailing input and capping
 * decompressed output at `maxOutput` bytes (the exact number of filtered
 * scanline bytes), so a small compressed payload cannot exhaust memory.
 *
 * Node's inflate stops at the end of the first zlib stream and silently
 * ignores remaining bytes (a second concatenated stream or arbitrary junk),
 * so exact input consumption is verified via bytesWritten.
 */
function inflateStrict(compressed, maxOutput) {
  return new Promise((resolve, reject) => {
    if (compressed.length < 2) {
      reject(new PngAuditError('ZLIB_ERROR', 'zlib stream is empty'));
      return;
    }
    const cmf = compressed[0];
    const flg = compressed[1];
    if ((cmf & 0x0f) !== 8 /* deflate */ || ((cmf * 256 + flg) % 31) !== 0) {
      reject(new PngAuditError('ZLIB_ERROR', 'invalid zlib header'));
      return;
    }
    const ds = zlib.createInflate();
    const chunks = [];
    let produced = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      ds.destroy();
      reject(err);
    };
    ds.on('data', (c) => {
      produced += c.length;
      if (produced > maxOutput) {
        fail(new PngAuditError('OUT_OF_BOUNDS_DECOMPRESSED_DATA',
          `decompressed data exceeds the ${maxOutput} B required for the ` +
          'filtered scanlines'));
        return;
      }
      chunks.push(c);
    });
    ds.on('error', (e) => fail(e));
    ds.on('end', () => {
      if (settled) return;
      const consumed = ds.bytesWritten;
      if (consumed !== compressed.length) {
        fail(new PngAuditError('ZLIB_TRAILING_BYTES',
          `${compressed.length - consumed} extraneous byte(s) after the ` +
          'zlib stream inside IDAT'));
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    ds.end(compressed);
  });
}
