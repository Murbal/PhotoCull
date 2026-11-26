import fs from 'node:fs/promises';
import path from 'node:path';
import { writeXmpMetadata } from './xmp.js';

/**
 * Pure-TypeScript synthetic valid JPEG encoder (baseline 8-bit YCbCr / grayscale or RGB-encoded via JFIF).
 * Generates real decodable JPEG images with crisp photographic-style gradients, sharpness focus targets,
 * high-contrast edges, and unique scenes so users & tests can test 100%/200% zoom, focus check,
 * RGB histograms, clipping warnings, and RAW container extraction with zero external image tools!
 */

const STD_LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

const STD_CHROMA_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

const ZIGZAG = [
  0, 1, 5, 6, 14, 15, 27, 28,
  2, 4, 7, 13, 16, 26, 29, 42,
  3, 8, 12, 17, 25, 30, 41, 43,
  9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54,
  20, 22, 33, 38, 46, 51, 55, 60,
  21, 34, 37, 47, 50, 56, 59, 61,
  35, 36, 48, 49, 57, 58, 62, 63,
];

const DC_LUMA_BITS = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

const DC_CHROMA_BITS = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHROMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_CHROMA_BITS = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

function buildHuffTable(bits: number[], vals: number[]): [number, number][] {
  const table: [number, number][] = new Array(256);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let j = 0; j < bits[len]; j++) {
      table[vals[k++]] = [code, len];
      code++;
    }
    code <<= 1;
  }
  return table;
}

const YDC_HT = buildHuffTable(DC_LUMA_BITS, DC_LUMA_VALS);
const YAC_HT = buildHuffTable(AC_LUMA_BITS, AC_LUMA_VALS);
const UVDC_HT = buildHuffTable(DC_CHROMA_BITS, DC_CHROMA_VALS);
const UVAC_HT = buildHuffTable(AC_CHROMA_BITS, AC_CHROMA_VALS);

// Precompute 1D DCT cosine matrix
const COS_TABLE: number[][] = Array.from({ length: 8 }, (_, u) =>
  Array.from({ length: 8 }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / 16)),
);

function fdct8x8(block: Float32Array, quant: number[]): Int32Array {
  const tmp = new Float32Array(64);
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += block[y * 8 + x] * COS_TABLE[u][x];
      tmp[y * 8 + u] = sum * (u === 0 ? 0.35355339 : 0.5);
    }
  }
  const out = new Int32Array(64);
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += tmp[y * 8 + u] * COS_TABLE[v][y];
      const val = sum * (v === 0 ? 0.35355339 : 0.5);
      const zz = ZIGZAG[v * 8 + u];
      out[zz] = Math.round(val / quant[zz]);
    }
  }
  return out;
}

/**
 * Encodes an RGB pixel buffer (`width * height * 3`) into a valid baseline JFIF JPEG buffer.
 */
export function encodeRgbToJpeg(
  rgb: Uint8Array,
  width: number,
  height: number,
  quality = 82,
): Buffer {
  const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  const qLuma = STD_LUMA_QUANT.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
  const qChroma = STD_CHROMA_QUANT.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));

  const bytes: number[] = [];
  const pushU16 = (v: number) => {
    bytes.push((v >> 8) & 0xff, v & 0xff);
  };

  // SOI
  bytes.push(0xff, 0xd8);
  // APP0 JFIF
  bytes.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);

  // DQT Luma & Chroma
  bytes.push(0xff, 0xdb, 0x00, 67, 0x00, ...qLuma);
  bytes.push(0xff, 0xdb, 0x00, 67, 0x01, ...qChroma);

  // SOF0 (Baseline DCT, 3 components, 4:4:4)
  bytes.push(0xff, 0xc0, 0x00, 17, 8);
  pushU16(height);
  pushU16(width);
  bytes.push(3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1);

  // DHT tables
  const writeDht = (info: number, bits: number[], vals: number[]) => {
    bytes.push(0xff, 0xc4);
    pushU16(2 + 1 + 16 + vals.length);
    bytes.push(info);
    for (let i = 1; i <= 16; i++) bytes.push(bits[i]);
    bytes.push(...vals);
  };
  writeDht(0x00, DC_LUMA_BITS, DC_LUMA_VALS);
  writeDht(0x10, AC_LUMA_BITS, AC_LUMA_VALS);
  writeDht(0x01, DC_CHROMA_BITS, DC_CHROMA_VALS);
  writeDht(0x11, AC_CHROMA_BITS, AC_CHROMA_VALS);

  // SOS
  bytes.push(0xff, 0xda, 0x00, 12, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0x00, 0x3f, 0x00);

  let bitBuf = 0;
  let bitPos = 0;
  const writeBits = (val: number, len: number) => {
    bitBuf = (bitBuf << len) | (val & ((1 << len) - 1));
    bitPos += len;
    while (bitPos >= 8) {
      bitPos -= 8;
      const b = (bitBuf >> bitPos) & 0xff;
      bytes.push(b);
      if (b === 0xff) bytes.push(0x00);
    }
  };

  const encodeVal = (v: number): [number, number] => {
    if (v === 0) return [0, 0];
    const abs = v < 0 ? -v : v;
    let bits = 0;
    let t = abs;
    while (t > 0) {
      bits++;
      t >>= 1;
    }
    return [v < 0 ? v + (1 << bits) - 1 : v, bits];
  };

  const encodeBlock = (
    dct: Int32Array,
    prevDc: number,
    dcHt: [number, number][],
    acHt: [number, number][],
  ): number => {
    const dcDiff = dct[0] - prevDc;
    if (dcDiff === 0) {
      writeBits(dcHt[0][0], dcHt[0][1]);
    } else {
      const [code, len] = encodeVal(dcDiff);
      writeBits(dcHt[len][0], dcHt[len][1]);
      writeBits(code, len);
    }

    let lastNonZero = 63;
    while (lastNonZero > 0 && dct[lastNonZero] === 0) lastNonZero--;
    if (lastNonZero === 0) {
      writeBits(acHt[0x00][0], acHt[0x00][1]);
      return dct[0];
    }

    let i = 1;
    while (i <= lastNonZero) {
      let zeros = 0;
      while (dct[i] === 0 && i <= lastNonZero) {
        zeros++;
        i++;
      }
      while (zeros >= 16) {
        writeBits(acHt[0xf0][0], acHt[0xf0][1]);
        zeros -= 16;
      }
      const [code, len] = encodeVal(dct[i]);
      const sym = (zeros << 4) | len;
      writeBits(acHt[sym][0], acHt[sym][1]);
      writeBits(code, len);
      i++;
    }
    if (lastNonZero < 63) {
      writeBits(acHt[0x00][0], acHt[0x00][1]);
    }
    return dct[0];
  };

  const yBlock = new Float32Array(64);
  const cbBlock = new Float32Array(64);
  const crBlock = new Float32Array(64);
  let dcY = 0;
  let dcCb = 0;
  let dcCr = 0;

  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y++) {
        const sy = Math.min(height - 1, by + y);
        for (let x = 0; x < 8; x++) {
          const sx = Math.min(width - 1, bx + x);
          const idx = (sy * width + sx) * 3;
          const r = rgb[idx];
          const g = rgb[idx + 1];
          const b = rgb[idx + 2];
          const p = y * 8 + x;
          yBlock[p] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          cbBlock[p] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          crBlock[p] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      dcY = encodeBlock(fdct8x8(yBlock, qLuma), dcY, YDC_HT, YAC_HT);
      dcCb = encodeBlock(fdct8x8(cbBlock, qChroma), dcCb, UVDC_HT, UVAC_HT);
      dcCr = encodeBlock(fdct8x8(crBlock, qChroma), dcCr, UVDC_HT, UVAC_HT);
    }
  }

  if (bitPos > 0) {
    writeBits((1 << (8 - bitPos)) - 1, 8 - bitPos);
  }
  // EOI
  bytes.push(0xff, 0xd9);
  return Buffer.from(bytes);
}

export interface DemoExifSpec {
  make: string;
  model: string;
  lens: string;
  exposureNum: number;
  exposureDen: number;
  fNum: number;
  fDen: number;
  iso: number;
  focalNum: number;
  focalDen: number;
  dateTime: string;
  orientation?: number;
}

/**
 * Builds a valid little-endian TIFF container (like Sony ARW / Nikon NEF / DNG)
 * with IFD0 (EXIF metadata), ExifIFD, SubIFD0 (full-size embedded JPEG), and IFD1 (fast thumbnail JPEG).
 */
export function buildSyntheticTiffRaw(
  fullJpeg: Buffer,
  thumbJpeg: Buffer,
  exif: DemoExifSpec,
): Buffer {
  // Layout:
  // 0x0000: TIFF header (8 bytes)
  // 0x0008: IFD0 (make, model, orientation, SubIFDs, ExifIFD) + nextIFD -> IFD1
  // Subsequent blocks: strings, rationals, ExifIFD, SubIFD0, IFD1, thumbJpeg, fullJpeg
  const chunks: Buffer[] = [];
  let cursor = 8;

  const alloc = (buf: Buffer): number => {
    const off = cursor;
    chunks.push(buf);
    cursor += buf.length;
    if (cursor % 2 !== 0) {
      chunks.push(Buffer.from([0]));
      cursor += 1;
    }
    return off;
  };

  const makeBuf = Buffer.from(`${exif.make}\0`, 'ascii');
  const modelBuf = Buffer.from(`${exif.model}\0`, 'ascii');
  const lensBuf = Buffer.from(`${exif.lens}\0`, 'ascii');
  const dateBuf = Buffer.from(`${exif.dateTime}\0`, 'ascii');

  const expBuf = Buffer.alloc(8);
  expBuf.writeUInt32LE(exif.exposureNum, 0);
  expBuf.writeUInt32LE(exif.exposureDen, 4);

  const fBuf = Buffer.alloc(8);
  fBuf.writeUInt32LE(exif.fNum, 0);
  fBuf.writeUInt32LE(exif.fDen, 4);

  const flBuf = Buffer.alloc(8);
  flBuf.writeUInt32LE(exif.focalNum, 0);
  flBuf.writeUInt32LE(exif.focalDen, 4);

  const writeIfd = (
    entries: { tag: number; type: number; count: number; value: number }[],
    nextIfdOffset: number,
  ): Buffer => {
    entries.sort((a, b) => a.tag - b.tag);
    const b = Buffer.alloc(2 + entries.length * 12 + 4);
    b.writeUInt16LE(entries.length, 0);
    entries.forEach((e, i) => {
      const o = 2 + i * 12;
      b.writeUInt16LE(e.tag, o);
      b.writeUInt16LE(e.type, o + 2);
      b.writeUInt32LE(e.count, o + 4);
      b.writeUInt32LE(e.value, o + 8);
    });
    b.writeUInt32LE(nextIfdOffset, 2 + entries.length * 12);
    return b;
  };

  // Reserve space for IFD0 (5 entries = 66 bytes)
  const ifd0Off = alloc(Buffer.alloc(2 + 5 * 12 + 4));
  const makeOff = alloc(makeBuf);
  const modelOff = alloc(modelBuf);
  const lensOff = alloc(lensBuf);
  const dateOff = alloc(dateBuf);
  const expOff = alloc(expBuf);
  const fOff = alloc(fBuf);
  const flOff = alloc(flBuf);

  const thumbOff = alloc(thumbJpeg);
  const fullOff = alloc(fullJpeg);

  // ExifIFD (6 entries)
  const exifIfdBuf = writeIfd(
    [
      { tag: 0x829a, type: 5, count: 1, value: expOff },
      { tag: 0x829d, type: 5, count: 1, value: fOff },
      { tag: 0x8827, type: 3, count: 1, value: exif.iso },
      { tag: 0x9003, type: 2, count: dateBuf.length, value: dateOff },
      { tag: 0x920a, type: 5, count: 1, value: flOff },
      { tag: 0xa434, type: 2, count: lensBuf.length, value: lensOff },
    ],
    0,
  );
  const exifIfdOff = alloc(exifIfdBuf);

  // SubIFD0 -> full preview JPEG
  const subIfdBuf = writeIfd(
    [
      { tag: 0x0201, type: 4, count: 1, value: fullOff },
      { tag: 0x0202, type: 4, count: 1, value: fullJpeg.length },
    ],
    0,
  );
  const subIfdOff = alloc(subIfdBuf);

  // IFD1 -> thumbnail JPEG
  const ifd1Buf = writeIfd(
    [
      { tag: 0x0201, type: 4, count: 1, value: thumbOff },
      { tag: 0x0202, type: 4, count: 1, value: thumbJpeg.length },
    ],
    0,
  );
  const ifd1Off = alloc(ifd1Buf);

  // Patch IFD0 in-place
  const ifd0Real = writeIfd(
    [
      { tag: 0x010f, type: 2, count: makeBuf.length, value: makeOff },
      { tag: 0x0110, type: 2, count: modelBuf.length, value: modelOff },
      { tag: 0x0112, type: 3, count: 1, value: exif.orientation ?? 1 },
      { tag: 0x014a, type: 4, count: 1, value: subIfdOff },
      { tag: 0x8769, type: 4, count: 1, value: exifIfdOff },
    ],
    ifd1Off,
  );
  chunks[0] = ifd0Real;

  const header = Buffer.alloc(8);
  header.write('II', 0, 'ascii');
  header.writeUInt16LE(0x002a, 2);
  header.writeUInt32LE(ifd0Off, 4);

  // Append a tiny dummy raw sensor tail (8KB) just to emulate raw payload after previews
  const sensorStub = Buffer.alloc(8192, 0x42);
  return Buffer.concat([header, ...chunks, sensorStub]);
}

/**
 * Builds a valid Canon `.CR3` (ISOBMFF) container with:
 * - `ftyp` ("crx ")
 * - `moov` containing Canon UUID (`CMT1`, `CMT2`, `THMB`) and Track 1 (`stsz` + `stco` pointing into `mdat`)
 * - `mdat` containing the full-res embedded JPEG
 */
export function buildSyntheticCr3Raw(
  fullJpeg: Buffer,
  thumbJpeg: Buffer,
  exif: DemoExifSpec,
): Buffer {
  const makeBox = (type: string, payload: Buffer): Buffer => {
    const hdr = Buffer.alloc(8);
    hdr.writeUInt32BE(8 + payload.length, 0);
    hdr.write(type, 4, 'latin1');
    return Buffer.concat([hdr, payload]);
  };

  // ftyp box
  const ftyp = makeBox('ftyp', Buffer.from('crx \x00\x00\x00\x01crx isom', 'latin1'));

  // Minimal TIFF inside CMT1 for EXIF
  const cmtTiff = buildSyntheticTiffRaw(thumbJpeg, thumbJpeg, exif);
  const cmt1 = makeBox('CMT1', cmtTiff);

  // THMB box (16-byte header + thumbJpeg)
  const thmbHdr = Buffer.alloc(16);
  thmbHdr.writeUInt16BE(240, 4);
  thmbHdr.writeUInt16BE(160, 6);
  thmbHdr.writeUInt32BE(thumbJpeg.length, 8);
  const thmb = makeBox('THMB', Buffer.concat([thmbHdr, thumbJpeg]));

  const moovUuidPayload = Buffer.concat([
    Buffer.from('85c0b687820f11e08111f4ce462b6a48', 'hex'),
    cmt1,
    thmb,
  ]);
  const moovUuid = makeBox('uuid', moovUuidPayload);

  // Build stsz
  const stszPayload = Buffer.alloc(16);
  stszPayload.writeUInt32BE(0, 0);
  stszPayload.writeUInt32BE(0, 4);
  stszPayload.writeUInt32BE(1, 8);
  stszPayload.writeUInt32BE(fullJpeg.length, 12);
  const stsz = makeBox('stsz', stszPayload);

  // Calculate exact offset of fullJpeg inside mdat (after ftyp + moov + 8-byte mdat header)
  const dummyStco = makeBox('stco', Buffer.alloc(12));
  const dummyMoov = makeBox(
    'moov',
    Buffer.concat([
      moovUuid,
      makeBox('trak', makeBox('mdia', makeBox('minf', makeBox('stbl', Buffer.concat([stsz, dummyStco]))))),
    ]),
  );

  const mdatDataOffset = ftyp.length + dummyMoov.length + 8;

  const stcoPayload = Buffer.alloc(12);
  stcoPayload.writeUInt32BE(0, 0);
  stcoPayload.writeUInt32BE(1, 4);
  stcoPayload.writeUInt32BE(mdatDataOffset, 8);
  const stco = makeBox('stco', stcoPayload);

  const moov = makeBox(
    'moov',
    Buffer.concat([
      moovUuid,
      makeBox('trak', makeBox('mdia', makeBox('minf', makeBox('stbl', Buffer.concat([stsz, stco]))))),
    ]),
  );

  const mdat = makeBox('mdat', Buffer.concat([fullJpeg, Buffer.alloc(4096, 0x11)]));
  return Buffer.concat([ftyp, moov, mdat]);
}

/**
 * Builds a valid Fujifilm `.RAF` container with embedded JPEG preview at header offsets 0x54 / 0x58.
 */
export function buildSyntheticRafRaw(fullJpeg: Buffer): Buffer {
  const hdr = Buffer.alloc(160);
  hdr.write('FUJIFILMCCD-RAW ', 0, 'ascii');
  hdr.write('0201', 16, 'ascii');
  hdr.write('X-T5', 28, 'ascii');
  hdr.writeUInt32BE(160, 0x54);
  hdr.writeUInt32BE(fullJpeg.length, 0x58);
  return Buffer.concat([hdr, fullJpeg, Buffer.alloc(4096, 0x22)]);
}

/**
 * Renders a scenic, realistic-looking photographic test frame (sunset mountain, portrait bokeh,
 * architectural lines, crisp focus chart) with configurable blur/sharpness to simulate burst culling!
 */
function renderDemoScene(
  width: number,
  height: number,
  sceneIdx: number,
  isSharp: boolean,
): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  const palettes = [
    // Golden hour mountains
    { top: [26, 42, 86], mid: [215, 118, 62], bot: [32, 28, 38], accent: [255, 224, 150] },
    // Moody studio portrait
    { top: [18, 24, 34], mid: [48, 62, 80], bot: [14, 16, 22], accent: [232, 186, 152] },
    // Neon street night
    { top: [12, 16, 36], mid: [34, 20, 62], bot: [18, 22, 32], accent: [56, 220, 245] },
    // Alpine mist / cyan forest
    { top: [176, 204, 218], mid: [78, 114, 118], bot: [20, 36, 34], accent: [248, 250, 252] },
    // Warm desert dunes
    { top: [42, 82, 148], mid: [222, 154, 92], bot: [122, 68, 36], accent: [255, 244, 210] },
    // High-contrast monochrome street
    { top: [22, 22, 24], mid: [125, 125, 130], bot: [16, 16, 18], accent: [248, 248, 248] },
  ];
  const p = palettes[sceneIdx % palettes.length];
  const shift = (sceneIdx * 17) % 100;
  const cx = width * (0.38 + ((sceneIdx % 5) * 0.06));
  const cy = height * (0.42 + (((sceneIdx + 2) % 4) * 0.04));

  for (let y = 0; y < height; y++) {
    const ny = y / height;
    const mountainH = 0.56 + 0.09 * Math.sin((y * 0.01) + sceneIdx) + 0.06 * Math.cos(sceneIdx * 2);
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      let r: number, g: number, b: number;

      // Sky gradient
      if (ny < 0.55) {
        const t = ny / 0.55;
        r = p.top[0] * (1 - t) + p.mid[0] * t;
        g = p.top[1] * (1 - t) + p.mid[1] * t;
        b = p.top[2] * (1 - t) + p.mid[2] * t;
      } else {
        const t = (ny - 0.55) / 0.45;
        r = p.mid[0] * (1 - t) + p.bot[0] * t;
        g = p.mid[1] * (1 - t) + p.bot[1] * t;
        b = p.mid[2] * (1 - t) + p.bot[2] * t;
      }

      // Layered ridge / horizon silhouette
      const ridge =
        0.58 +
        0.08 * Math.sin(nx * 6.5 + sceneIdx * 1.4) +
        0.04 * Math.sin(nx * 15.0 + shift);
      if (ny > ridge) {
        const depth = Math.min(1, (ny - ridge) * 5);
        r = r * (1 - depth * 0.72) + p.bot[0] * depth * 0.72;
        g = g * (1 - depth * 0.72) + p.bot[1] * depth * 0.72;
        b = b * (1 - depth * 0.72) + p.bot[2] * depth * 0.72;
      }

      // Foreground subject / focus target (sharp concentric iris/grid pattern vs soft missed focus)
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      const radius = Math.min(width, height) * 0.22;

      if (dist < radius) {
        const ring = isSharp
          ? Math.sin(dist * 0.65) * 0.5 + 0.5
          : Math.sin(dist * 0.12) * 0.25 + 0.5;
        const rim = Math.exp(-Math.pow((dist - radius * 0.75) / (radius * 0.14), 2));
        const blend = Math.max(0, 1 - dist / radius) * 0.82;

        // Subtle high-frequency focus micro-texture on sharp frames for 100%/200% zoom testing
        const microDetail = isSharp
          ? ((Math.sin(x * 0.9) * Math.cos(y * 0.9)) > 0.3 ? 28 : -16)
          : 0;

        r = r * (1 - blend) + (p.accent[0] * (0.55 + 0.45 * ring) + microDetail) * blend + rim * 45;
        g = g * (1 - blend) + (p.accent[1] * (0.55 + 0.45 * ring) + microDetail) * blend + rim * 40;
        b = b * (1 - blend) + (p.accent[2] * (0.55 + 0.45 * ring) + microDetail) * blend + rim * 35;
      }

      // Subtle sun/specular highlight spot (tests highlight clipping warning on some frames!)
      const sx = width * (0.72 - (sceneIdx % 3) * 0.12);
      const sy = height * 0.26;
      const sDist = Math.hypot(x - sx, y - sy);
      if (sDist < width * 0.12) {
        const glow = Math.pow(1 - sDist / (width * 0.12), 2.4) * (sceneIdx % 3 === 0 ? 255 : 150);
        r += glow;
        g += glow * 0.94;
        b += glow * 0.82;
      }

      // Vignette
      const vx = nx - 0.5;
      const vy = ny - 0.5;
      const vig = 1 - (vx * vx + vy * vy) * 0.65;

      const idx = (y * width + x) * 3;
      rgb[idx] = Math.max(0, Math.min(255, Math.round(r * vig + (mountainH > 0 ? 0 : 0))));
      rgb[idx + 1] = Math.max(0, Math.min(255, Math.round(g * vig)));
      rgb[idx + 2] = Math.max(0, Math.min(255, Math.round(b * vig)));
    }
  }
  return rgb;
}

/**
 * Generates a realistic multi-camera RAW + JPEG demo shoot (Sony ARW, Canon CR3, Nikon NEF, Fujifilm RAF)
 * with embedded high-res previews, thumbnails, EXIF metadata, and sample XMP sidecars.
 */
export async function generateDemoShoot(targetDir: string, count = 24): Promise<{ folder: string; created: number }> {
  const dir = path.resolve(targetDir);
  await fs.mkdir(dir, { recursive: true });

  const cameras: { ext: string; make: string; model: string; lens: string; kind: 'tiff' | 'cr3' | 'raf'; pairJpg: boolean }[] = [
    { ext: '.ARW', make: 'SONY', model: 'ILCE-7RM5', lens: 'FE 85mm F1.4 GM II', kind: 'tiff', pairJpg: true },
    { ext: '.CR3', make: 'Canon', model: 'Canon EOS R5', lens: 'RF50mm F1.2 L USM', kind: 'cr3', pairJpg: false },
    { ext: '.NEF', make: 'NIKON CORPORATION', model: 'NIKON Z 8', lens: 'NIKKOR Z 70-200mm f/2.8 VR S', kind: 'tiff', pairJpg: true },
    { ext: '.RAF', make: 'FUJIFILM', model: 'X-T5', lens: 'XF35mmF1.4 R', kind: 'raf', pairJpg: false },
  ];

  const shutters: [number, number][] = [
    [1, 2000], [1, 1000], [1, 500], [1, 250], [1, 125], [1, 60],
  ];
  const apertures: [number, number][] = [
    [14, 10], [18, 10], [20, 10], [28, 10], [40, 10], [56, 10],
  ];
  const isos = [100, 200, 400, 800, 1600, 3200];
  const focals = [35, 50, 85, 135, 200];

  for (let i = 0; i < count; i++) {
    const cam = cameras[i % cameras.length];
    const numStr = String(1001 + i).padStart(4, '0');
    const baseName = `DSC0${numStr}`;
    const rawName = `${baseName}${cam.ext}`;
    const isSharp = i % 3 !== 2; // Every 3rd burst shot is slightly soft to demo 100% focus culling!

    const fullRgb = renderDemoScene(960, 640, i, isSharp);
    const thumbRgb = renderDemoScene(320, 216, i, isSharp);
    const fullJpeg = encodeRgbToJpeg(fullRgb, 960, 640, 84);
    const thumbJpeg = encodeRgbToJpeg(thumbRgb, 320, 216, 74);

    const [sNum, sDen] = shutters[i % shutters.length];
    const [fNum, fDen] = apertures[i % apertures.length];
    const sec = String(10 + (i % 50)).padStart(2, '0');
    const min = String(14 + Math.floor(i / 6)).padStart(2, '0');

    const exif: DemoExifSpec = {
      make: cam.make,
      model: cam.model,
      lens: cam.lens,
      exposureNum: sNum,
      exposureDen: sDen,
      fNum,
      fDen,
      iso: isos[i % isos.length],
      focalNum: focals[i % focals.length] * 10,
      focalDen: 10,
      dateTime: `2026:11:25 14:${min}:${sec}`,
      orientation: 1,
    };

    let rawBytes: Buffer;
    if (cam.kind === 'cr3') {
      rawBytes = buildSyntheticCr3Raw(fullJpeg, thumbJpeg, exif);
    } else if (cam.kind === 'raf') {
      rawBytes = buildSyntheticRafRaw(fullJpeg);
    } else {
      rawBytes = buildSyntheticTiffRaw(fullJpeg, thumbJpeg, exif);
    }

    await fs.writeFile(path.join(dir, rawName), rawBytes);

    if (cam.pairJpg) {
      await fs.writeFile(path.join(dir, `${baseName}.JPG`), fullJpeg);
    }

    // Seed a few sample XMP star ratings so filtering & XMP badges are immediately visible
    if (i === 0) {
      await writeXmpMetadata(dir, baseName, rawName, 5);
    } else if (i === 3 || i === 6) {
      await writeXmpMetadata(dir, baseName, rawName, 4);
    } else if (i === 1) {
      await writeXmpMetadata(dir, baseName, rawName, 3);
    } else if (i === 2) {
      await writeXmpMetadata(dir, baseName, rawName, 1);
    }
  }

  return { folder: dir, created: count };
}
