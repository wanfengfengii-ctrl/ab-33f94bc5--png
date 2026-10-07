import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { auditPng, PngAuditError } from '../src/png.js';
import {
  buildPng, chunk, crc32, SIGNATURE, validGrayPng, validRgbaPng, sha256,
} from './fixtures.js';

async function expectReject(png, code, extra = {}) {
  await assert.rejects(
    () => auditPng(png),
    (err) => {
      assert.ok(err instanceof PngAuditError, `expected PngAuditError, got ${err}`);
      assert.equal(err.code, code,
        `expected code ${code}, got ${err.code} (${err.message})`);
      for (const [k, v] of Object.entries(extra)) {
        const field = k === 'chunk' ? 'chunkNumber'
          : k === 'line' ? 'lineNumber' : k;
        assert.equal(err[field], v, `expected ${k}=${v}, got ${err[field]}`);
      }
      return true;
    },
  );
}

const pixelsHash = (pixels) => sha256(Buffer.concat(pixels));

describe('valid images', () => {
  for (const filterType of [0, 1, 2, 3, 4]) {
    test(`grayscale 8-bit, filter ${filterType}`, async () => {
      const { png, pixels } = buildPng({
        width: 7, height: 5, colorType: 0, filterType,
      });
      const r = await auditPng(png);
      assert.deepEqual(
        { ...r, sha256: undefined },
        { width: 7, height: 5, colorType: 0, pixelBytes: 35, sha256: undefined },
      );
      assert.equal(r.sha256, pixelsHash(pixels));
      assert.match(r.sha256, /^[0-9a-f]{64}$/);
    });
  }

  for (const filterType of [0, 1, 2, 3, 4]) {
    test(`RGBA 8-bit, filter ${filterType}`, async () => {
      const { png, pixels } = buildPng({
        width: 3, height: 4, colorType: 6, filterType,
      });
      const r = await auditPng(png);
      assert.equal(r.width, 3);
      assert.equal(r.height, 4);
      assert.equal(r.colorType, 6);
      assert.equal(r.pixelBytes, 3 * 4 * 4);
      assert.equal(r.sha256, pixelsHash(pixels));
    });
  }

  test('IDAT payload split across multiple consecutive chunks', async () => {
    const { png, pixels } = buildPng({ idatSplits: 5, filterType: 3 });
    const r = await auditPng(png);
    assert.equal(r.sha256, pixelsHash(pixels));
  });

  test('known and unknown ancillary chunks are tolerated (CRC still checked)',
    async () => {
      const unknownAnc = chunk('xyZa', Buffer.from('hello'));
      const text = chunk('tEXt', Buffer.concat([
        Buffer.from('Comment\x00'), Buffer.from('microscopy run 42'),
      ]));
      const { png, pixels } = buildPng({
        filterType: 4,
        extraChunks: [text],
        chunksAfterIdat: [unknownAnc],
      });
      const r = await auditPng(png);
      assert.equal(r.sha256, pixelsHash(pixels));
    });

  test('1x1 boundary image', async () => {
    const { png } = buildPng({ width: 1, height: 1, filterType: 0 });
    const r = await auditPng(png);
    assert.equal(r.pixelBytes, 1);
  });

  test('4096x4096 is accepted at the dimension ceiling', async () => {
    // Keep memory modest: only structural math matters, so build a valid
    // 4096x4096 grayscale raw buffer of zero bytes.
    const width = 4096, height = 4096;
    const stride = width;
    const raw = Buffer.alloc(height * (stride + 1)); // filter 0, zeros
    const { png } = buildPng({ width, height, rawOverride: raw });
    const r = await auditPng(png);
    assert.equal(r.pixelBytes, width * height);
    assert.equal(r.sha256, sha256(Buffer.alloc(width * height)));
  });
});

describe('signature / framing', () => {
  test('bad signature', async () => {
    const { png } = validGrayPng();
    png[0] = 0;
    await expectReject(png, 'INVALID_SIGNATURE');
  });

  test('empty body', async () => {
    await expectReject(Buffer.alloc(0), 'EMPTY_BODY');
  });

  test('trailing bytes after IEND', async () => {
    const { png } = buildPng({ trailing: Buffer.from([0, 1, 2]) });
    await expectReject(png, 'TRAILING_BYTES', { chunk: 3 });
  });

  test('truncated mid-chunk (declared length exceeds file)', async () => {
    const { png } = validGrayPng();
    await expectReject(png.subarray(0, png.length - 10), 'TRUNCATED_CHUNK');
  });

  test('truncated inside chunk header', async () => {
    const { png } = validGrayPng();
    await expectReject(png.subarray(0, SIGNATURE.length + 3),
      'TRUNCATED_CHUNK', { chunk: 1 });
  });

  test('missing IEND', async () => {
    const { png } = validGrayPng();
    // Drop the final 12-byte IEND chunk.
    await expectReject(png.subarray(0, png.length - 12), 'MISSING_IEND');
  });

  test('bad CRC reports the failing chunk number', async () => {
    const { png } = validGrayPng();
    // Signature(8) + IHDR(25) brings us to the IDAT chunk; skip its
    // length(4) and type(4) fields, then corrupt a data byte.
    png[8 + 25 + 8 + 2] ^= 0xff;
    await expectReject(png, 'CRC_MISMATCH', { chunk: 2 });
  });

  test('non-letter chunk type bytes', async () => {
    // sig + IHDR + tEXt + IDAT + IEND; corrupt the tEXt type and then
    // recompute its CRC so the failure is specifically the type itself.
    const built = buildPng({
      extraChunks: [chunk('tEXt', Buffer.from('ab'))],
    });
    const lengthField = 8 + 25;           // tEXt chunk starts here
    const typeStart = lengthField + 4;    // 4-byte length precedes type
    built.png[typeStart] = 0x00;          // 't' -> NUL
    const dataLen = built.png.readUInt32BE(lengthField);
    built.png.writeUInt32BE(
      crc32(built.png.subarray(typeStart, typeStart + 4 + dataLen)),
      typeStart + 4 + dataLen,
    );
    await expectReject(built.png, 'INVALID_CHUNK_TYPE', { chunk: 2 });
  });

  test('unknown critical chunk is rejected', async () => {
    const fake = chunk('FAKE', Buffer.from('nope'));
    const { png } = buildPng({ extraChunks: [fake] });
    await expectReject(png, 'UNKNOWN_CRITICAL_CHUNK', { chunk: 2 });
  });
});

describe('chunk order / IDAT contiguity', () => {
  test('IDAT, ancillary, IDAT is rejected as non-contiguous', async () => {
    const text = chunk('tEXt', Buffer.from('c\x00x'));
    const { raw } = validGrayPng();
    const comp = zlib.deflateSync(raw);
    const half = Math.ceil(comp.length / 2);
    const manual = Buffer.concat([
      SIGNATURE,
      chunk('IHDR', (() => {
        const d = Buffer.alloc(13);
        d.writeUInt32BE(4, 0); d.writeUInt32BE(4, 4);
        d[8] = 8; d[9] = 0; d[12] = 0; return d;
      })()),
      chunk('IDAT', comp.subarray(0, half)),
      text,
      chunk('IDAT', comp.subarray(half)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    await expectReject(manual, 'NONCONTIGUOUS_IDAT', { chunk: 4 });
  });

  test('IHDR not first is rejected', async () => {
    const text = chunk('tEXt', Buffer.from('a\x00b'));
    const { png } = validGrayPng();
    const reordered = Buffer.concat([
      png.subarray(0, 8), text, png.subarray(8),
    ]);
    await expectReject(reordered, 'BAD_CHUNK_ORDER', { chunk: 1 });
  });

  test('missing IDAT is rejected at IEND', async () => {
    const d = Buffer.alloc(13);
    d.writeUInt32BE(1, 0); d.writeUInt32BE(1, 4); d[8] = 8;
    const noIdat = Buffer.concat([
      SIGNATURE, chunk('IHDR', d), chunk('IEND', Buffer.alloc(0)),
    ]);
    await expectReject(noIdat, 'MISSING_IDAT', { chunk: 2 });
  });

  test('IEND with data is rejected', async () => {
    const { png } = validGrayPng();
    // Replace last IEND chunk (length field currently 0).
    const iendStart = png.length - 12;
    const replacement = chunk('IEND', Buffer.from('x'));
    const out = Buffer.concat([png.subarray(0, iendStart), replacement]);
    await expectReject(out, 'INVALID_IEND', { chunk: 3 });
  });
});

describe('IHDR constraints', () => {
  const mkHeader = (fields) => {
    const d = Buffer.alloc(13);
    d.writeUInt32BE(fields.width ?? 4, 0);
    d.writeUInt32BE(fields.height ?? 4, 4);
    d[8] = fields.bitDepth ?? 8;
    d[9] = fields.colorType ?? 0;
    d[10] = fields.compression ?? 0;
    d[11] = fields.filter ?? 0;
    d[12] = fields.interlace ?? 0;
    return d;
  };
  const oneChunkPng = (d, idatData = zlib.deflateSync(Buffer.from([0, 7]))) =>
    Buffer.concat([
      SIGNATURE, chunk('IHDR', d),
      chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0)),
    ]);

  test('width 0 rejected', () => expectReject(
    oneChunkPng(mkHeader({ width: 0, height: 1 })), 'INVALID_DIMENSIONS'));
  test('width 4097 rejected', () => expectReject(
    oneChunkPng(mkHeader({ width: 4097 })), 'INVALID_DIMENSIONS'));
  test('height 0 rejected', () => expectReject(
    oneChunkPng(mkHeader({ width: 1, height: 0 })), 'INVALID_DIMENSIONS'));
  test('height 4097 rejected', () => expectReject(
    oneChunkPng(mkHeader({ height: 4097 })), 'INVALID_DIMENSIONS'));
  test('16-bit rejected', () => expectReject(
    oneChunkPng(mkHeader({ bitDepth: 16 })), 'UNSUPPORTED_BIT_DEPTH'));
  test('color type 2 (RGB) rejected', () => expectReject(
    oneChunkPng(mkHeader({ colorType: 2 })), 'UNSUPPORTED_COLOR_TYPE'));
  test('color type 4 (GA) rejected', () => expectReject(
    oneChunkPng(mkHeader({ colorType: 4 })), 'UNSUPPORTED_COLOR_TYPE'));
  test('color type 3 (indexed) is rejected at IHDR', () => expectReject(
    oneChunkPng(mkHeader({ colorType: 3 })),
    'UNSUPPORTED_COLOR_TYPE', { chunk: 1 }));
  test('interlaced (Adam7) rejected', () => expectReject(
    oneChunkPng(mkHeader({ interlace: 1 })), 'INTERLACED_UNSUPPORTED'));
  test('unknown compression method rejected', () => expectReject(
    oneChunkPng(mkHeader({ compression: 1 })), 'INVALID_IHDR'));
  test('unknown filter method rejected', () => expectReject(
    oneChunkPng(mkHeader({ filter: 1 })), 'INVALID_IHDR'));
});

describe('zlib stream boundaries', () => {
  test('junk appended after the zlib stream is rejected', async () => {
    const { raw } = validGrayPng();
    const comp = zlib.deflateSync(raw);
    const evil = Buffer.concat([comp, Buffer.from('JUNKDATA')]);
    const { png } = buildPng({ compressedOverride: evil });
    await expectReject(png, 'ZLIB_TRAILING_BYTES');
  });

  test('second concatenated zlib stream is rejected', async () => {
    const { raw } = validGrayPng();
    const two = Buffer.concat([zlib.deflateSync(raw), zlib.deflateSync(raw)]);
    const { png } = buildPng({ compressedOverride: two });
    await expectReject(png, 'ZLIB_TRAILING_BYTES');
  });

  test('truncated zlib stream is rejected', async () => {
    const { raw } = validGrayPng();
    const comp = zlib.deflateSync(raw);
    const { png } = buildPng({ compressedOverride: comp.subarray(0, comp.length - 4) });
    await expectReject(png, 'ZLIB_ERROR');
  });

  test('invalid zlib header is rejected', async () => {
    const { png } = buildPng({ compressedOverride: Buffer.from([0xff, 0xff, 0, 0]) });
    await expectReject(png, 'ZLIB_ERROR');
  });

  test('decompression bomb is stopped at the scanline byte boundary',
    async () => {
      const bomb = zlib.deflateSync(Buffer.alloc(20_000_000, 0x41));
      assert.ok(bomb.length < 100_000);
      const { png } = buildPng({ width: 4, height: 4, compressedOverride: bomb });
      await expectReject(png, 'OUT_OF_BOUNDS_DECOMPRESSED_DATA');
    });
});

describe('scanline coverage and filters', () => {
  test('decompressed data longer than all filtered scanlines is rejected',
    async () => {
      const stride = 4;
      const raw = Buffer.alloc(4 * (stride + 1) + 3, 0);
      // Declare 4x4 grayscale but supply 3 extra decompressed bytes.
      const { png } = buildPng({ width: 4, height: 4, rawOverride: raw });
      await expectReject(png, 'OUT_OF_BOUNDS_DECOMPRESSED_DATA');
    });

  test('truncated final scanline reports its line number', async () => {
    const stride = 4;
    const raw = Buffer.alloc(4 * (stride + 1) - 1, 0);
    const { png } = buildPng({ width: 4, height: 4, rawOverride: raw });
    await expectReject(png, 'TRUNCATED_SCANLINE', { line: 4 });
  });

  test('raw shorter than even one line reports line 1', async () => {
    const raw = Buffer.from([0, 1, 2]);
    const { png } = buildPng({ width: 4, height: 4, rawOverride: raw });
    await expectReject(png, 'TRUNCATED_SCANLINE', { line: 1 });
  });

  test('unknown filter type reports the offending scanline', async () => {
    const { raw } = buildPng({ width: 4, height: 4, filterType: 0 });
    raw[(stride4() + 1) * 2] = 5; // row 3 (0-based 2)
    const { png } = buildPng({ width: 4, height: 4, rawOverride: raw });
    await expectReject(png, 'INVALID_FILTER_TYPE', { line: 3 });
  });

  function stride4() { return 4; }

  test('filters reconstruct byte-identical rows for adversarial data',
    async () => {
      // Rows chosen to stress wrapping arithmetic and predictor edges.
      const pixels = [
        Buffer.from([0, 255, 1, 254, 128, 127]),
        Buffer.from([255, 0, 200, 55, 7, 99]),
        Buffer.from([42, 42, 42, 42, 42, 42]),
      ];
      for (const f of [0, 1, 2, 3, 4]) {
        const { png } = buildPng({
          width: 6, height: 3, filterType: f, pixels,
        });
        const r = await auditPng(png);
        assert.equal(r.sha256, pixelsHash(pixels), `filter ${f} mismatch`);
      }
    });

  test('RGBA bpp boundary: Sub filter at first pixel uses a=0', async () => {
    const pixels = [Buffer.from([250, 251, 252, 253, 1, 2, 3, 4])];
    const { png } = buildPng({
      width: 2, height: 1, colorType: 6, filterType: 1, pixels,
    });
    const r = await auditPng(png);
    assert.equal(r.sha256, pixelsHash(pixels));
  });
});

describe('RGBA fixture', () => {
  test('valid RGBA fixture audits', async () => {
    const { png, pixels } = validRgbaPng();
    const r = await auditPng(png);
    assert.equal(r.colorType, 6);
    assert.equal(r.sha256, pixelsHash(pixels));
  });
});
