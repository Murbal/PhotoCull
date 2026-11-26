import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildSyntheticCr3Raw,
  buildSyntheticRafRaw,
  buildSyntheticTiffRaw,
  encodeRgbToJpeg,
} from '../server/demoGenerator.js';
import { indexPhotoFile, readPhotoImageBytes } from '../server/raw/extractor.js';
import { applyExifOrientation } from '../server/raw/focusPoints.js';
import { parseJpegDimensionsFromBuffer } from '../server/raw/jpegMeta.js';
import { parseXmpContent, patchXmpContent, writeXmpMetadata } from '../server/xmp.js';

let tmpDir = '';

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-raw-test-'));
});

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeSolidJpeg(w: number, h: number, r: number, g: number, b: number): Buffer {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return encodeRgbToJpeg(rgb, w, h, 80);
}

describe('Native Binary RAW Embedded Preview & EXIF Extractor', () => {
  test('extracts largest preview, smaller thumbnail, and EXIF from TIFF-based .ARW/.NEF/.DNG', async () => {
    const fullJpeg = makeSolidJpeg(640, 424, 220, 120, 40);
    const thumbJpeg = makeSolidJpeg(320, 216, 220, 120, 40);
    const arwBytes = buildSyntheticTiffRaw(fullJpeg, thumbJpeg, {
      make: 'SONY',
      model: 'ILCE-7RM5',
      lens: 'FE 85mm F1.4 GM II',
      exposureNum: 1,
      exposureDen: 1000,
      fNum: 14,
      fDen: 10,
      iso: 400,
      focalNum: 850,
      focalDen: 10,
      dateTime: '2026:11:25 14:30:00',
      orientation: 1,
    });

    const arwPath = path.join(tmpDir, 'DSC01001.ARW');
    await fs.writeFile(arwPath, arwBytes);

    const idx = await indexPhotoFile(arwPath);
    expect(idx.isRaw).toBe(true);
    expect(idx.preview?.width).toBe(640);
    expect(idx.preview?.height).toBe(424);
    expect(idx.thumbnail?.width).toBe(320);
    expect(idx.thumbnail?.height).toBe(216);

    expect(idx.exif.make).toBe('SONY');
    expect(idx.exif.model).toBe('ILCE-7RM5');
    expect(idx.exif.lens).toBe('FE 85mm F1.4 GM II');
    expect(idx.exif.exposureTime).toBe('1/1000s');
    expect(idx.exif.fNumber).toBe(1.4);
    expect(idx.exif.iso).toBe(400);
    expect(idx.exif.focalLength).toBe(85);
    expect(idx.exif.dateTimeOriginal).toBe('2026:11:25 14:30:00');

    const extractedPreview = await readPhotoImageBytes(arwPath, 'preview');
    expect(extractedPreview).not.toBeNull();
    expect(extractedPreview!.bytes.equals(fullJpeg)).toBe(true);
    expect(parseJpegDimensionsFromBuffer(extractedPreview!.bytes)).toEqual({ width: 640, height: 424 });

    const extractedThumb = await readPhotoImageBytes(arwPath, 'thumb');
    expect(extractedThumb).not.toBeNull();
    expect(extractedThumb!.bytes.equals(thumbJpeg)).toBe(true);
  });

  test('extracts full-res Track 1 JPEG, THMB thumbnail, and CMT1 EXIF from Canon .CR3 (ISOBMFF)', async () => {
    const fullJpeg = makeSolidJpeg(800, 536, 40, 120, 220);
    const thumbJpeg = makeSolidJpeg(320, 216, 40, 120, 220);
    const cr3Bytes = buildSyntheticCr3Raw(fullJpeg, thumbJpeg, {
      make: 'Canon',
      model: 'Canon EOS R5',
      lens: 'RF50mm F1.2 L USM',
      exposureNum: 1,
      exposureDen: 2000,
      fNum: 12,
      fDen: 10,
      iso: 200,
      focalNum: 500,
      focalDen: 10,
      dateTime: '2026:11:25 14:31:00',
    });

    const cr3Path = path.join(tmpDir, 'IMG_0001.CR3');
    await fs.writeFile(cr3Path, cr3Bytes);

    const idx = await indexPhotoFile(cr3Path);
    expect(idx.isRaw).toBe(true);
    expect(idx.preview?.source).toBe('CR3:TrackFullJPEG');
    expect(idx.preview?.width).toBe(800);
    expect(idx.preview?.height).toBe(536);
    expect(idx.thumbnail?.width).toBe(320);
    expect(idx.exif.model).toBe('Canon EOS R5');
    expect(idx.exif.lens).toBe('RF50mm F1.2 L USM');
    expect(idx.exif.exposureTime).toBe('1/2000s');
    expect(idx.exif.fNumber).toBe(1.2);
    expect(idx.exif.iso).toBe(200);

    const previewData = await readPhotoImageBytes(cr3Path, 'preview');
    expect(previewData!.bytes.equals(fullJpeg)).toBe(true);
  });

  test('extracts embedded JPEG preview from Fujifilm .RAF', async () => {
    const fullJpeg = makeSolidJpeg(720, 480, 60, 180, 110);
    const rafBytes = buildSyntheticRafRaw(fullJpeg);
    const rafPath = path.join(tmpDir, 'DSCF0042.RAF');
    await fs.writeFile(rafPath, rafBytes);

    const idx = await indexPhotoFile(rafPath);
    expect(idx.isRaw).toBe(true);
    expect(idx.preview?.source).toBe('RAF:EmbeddedJPEG');
    expect(idx.preview?.width).toBe(720);
    expect(idx.preview?.height).toBe(480);

    const previewData = await readPhotoImageBytes(rafPath, 'preview');
    expect(previewData!.bytes.equals(fullJpeg)).toBe(true);
  });
});

describe('Standard Adobe .XMP Sidecar Interoperability (xmp:Rating Only)', () => {
  test('creates, reads, and clears standard xmp:Rating cleanly', async () => {
    const meta1 = await writeXmpMetadata(tmpDir, 'DSC01001', 'DSC01001.ARW', 4);
    expect(meta1).toEqual({ rating: 4, hasXmp: true });

    const rawXml = await fs.readFile(path.join(tmpDir, 'DSC01001.xmp'), 'utf8');
    expect(rawXml).toContain('xmp:Rating="4"');
    expect(rawXml).not.toContain('xmp:Label');
    expect(rawXml).not.toContain('photocull:Flag');
    expect(rawXml).not.toContain('photomechanic:Tagged');

    expect(parseXmpContent(rawXml)).toEqual({ rating: 4, hasXmp: true });

    // Clearing rating (0) removes xmp:Rating attribute
    const meta0 = await writeXmpMetadata(tmpDir, 'DSC01001', 'DSC01001.ARW', 0);
    expect(meta0).toEqual({ rating: 0, hasXmp: true });
    const clearedXml = await fs.readFile(path.join(tmpDir, 'DSC01001.xmp'), 'utf8');
    expect(clearedXml).not.toContain('xmp:Rating=');
    expect(parseXmpContent(clearedXml)).toEqual({ rating: 0, hasXmp: true });
  });

  test('preserves pre-existing Lightroom CRS develop settings & dc:subject keywords untouched', () => {
    const lightroomXmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmp:Rating="2"
      crs:Exposure2012="+0.65"
      crs:Contrast2012="+18"
      crs:WhiteBalance="Custom">
      <dc:subject>
        <rdf:Bag>
          <rdf:li>street</rdf:li>
          <rdf:li>vienna</rdf:li>
        </rdf:Bag>
      </dc:subject>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

    const patched = patchXmpContent(lightroomXmp, 5);

    expect(patched).toContain('xmp:Rating="5"');
    expect(patched).toContain('crs:Exposure2012="+0.65"');
    expect(patched).toContain('crs:Contrast2012="+18"');
    expect(patched).toContain('crs:WhiteBalance="Custom"');
    expect(patched).toContain('<rdf:li>street</rdf:li>');
    expect(patched).toContain('<rdf:li>vienna</rdf:li>');

    expect(parseXmpContent(patched)).toEqual({ rating: 5, hasXmp: true });
  });
});

/**
 * Builds a minimal JPEG with an EXIF APP1 segment containing IFD0 + ExifIFD + FUJIFILM MakerNote.
 */
function buildFujifilmJpegWithFocus(opts: {
  jpegWidth: number;
  jpegHeight: number;
  orientation: number;
  exifImageWidth?: number;
  exifImageHeight?: number;
  focusPixel?: [number, number];
  focusMode?: number;
  afMode?: number;
  focusSettings?: number;
  focusWarning?: number;
}): Buffer {
  const baseJpeg = makeSolidJpeg(opts.jpegWidth, opts.jpegHeight, 100, 140, 180);

  // Build FUJIFILM MakerNote (always LE, offsets relative to start of "FUJIFILM")
  const mnEntries: Buffer[] = [];
  const pushMnU16 = (tag: number, val: number) => {
    const e = Buffer.alloc(12);
    e.writeUInt16LE(tag, 0);
    e.writeUInt16LE(3, 2); // SHORT
    e.writeUInt32LE(1, 4);
    e.writeUInt16LE(val, 8);
    mnEntries.push(e);
  };
  const pushMnU32 = (tag: number, val: number) => {
    const e = Buffer.alloc(12);
    e.writeUInt16LE(tag, 0);
    e.writeUInt16LE(4, 2); // LONG
    e.writeUInt32LE(1, 4);
    e.writeUInt32LE(val >>> 0, 8);
    mnEntries.push(e);
  };
  if (opts.focusMode !== undefined) pushMnU16(0x1021, opts.focusMode);
  if (opts.afMode !== undefined) pushMnU16(0x1022, opts.afMode);
  if (opts.focusPixel) {
    const e = Buffer.alloc(12);
    e.writeUInt16LE(0x1023, 0);
    e.writeUInt16LE(3, 2); // SHORT
    e.writeUInt32LE(2, 4); // count = 2 (inline 4 bytes)
    e.writeUInt16LE(opts.focusPixel[0], 8);
    e.writeUInt16LE(opts.focusPixel[1], 10);
    mnEntries.push(e);
  }
  if (opts.focusSettings !== undefined) pushMnU32(0x102d, opts.focusSettings);
  if (opts.focusWarning !== undefined) pushMnU16(0x1301, opts.focusWarning);

  const mnHeader = Buffer.alloc(12);
  mnHeader.write('FUJIFILM', 0, 'ascii');
  mnHeader.writeUInt32LE(12, 8); // ifdRelOffset = 12
  const mnCount = Buffer.alloc(2);
  mnCount.writeUInt16LE(mnEntries.length, 0);
  const mnNext = Buffer.alloc(4);
  const makerNote = Buffer.concat([mnHeader, mnCount, ...mnEntries, mnNext]);

  // Build EXIF TIFF (LE):
  // [0..7] TIFF header (II 0x002A, IFD0 offset = 8)
  // [8..] IFD0: Make (0x010F), Orientation (0x0112), ExifIFD (0x8769)
  const makeBytes = Buffer.from('FUJIFILM\0', 'ascii');
  const ifd0Count = 3;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const makeOffset = 8 + ifd0Size;
  const exifIfdOffset = makeOffset + makeBytes.length;

  const exifEntries: { tag: number; type: number; count: number; val: number }[] = [];
  if (opts.exifImageWidth !== undefined) {
    exifEntries.push({ tag: 0xa002, type: 4, count: 1, val: opts.exifImageWidth });
  }
  if (opts.exifImageHeight !== undefined) {
    exifEntries.push({ tag: 0xa003, type: 4, count: 1, val: opts.exifImageHeight });
  }
  const exifIfdSize = 2 + (exifEntries.length + 1) * 12 + 4;
  const makerNoteOffset = exifIfdOffset + exifIfdSize;
  exifEntries.push({ tag: 0x927c, type: 7, count: makerNote.length, val: makerNoteOffset });

  const tiffBuf = Buffer.alloc(makerNoteOffset + makerNote.length);
  tiffBuf.write('II', 0, 'ascii');
  tiffBuf.writeUInt16LE(0x002a, 2);
  tiffBuf.writeUInt32LE(8, 4);

  // IFD0
  let p = 8;
  tiffBuf.writeUInt16LE(ifd0Count, p);
  p += 2;
  const writeIfdEntry = (tag: number, type: number, count: number, val: number) => {
    tiffBuf.writeUInt16LE(tag, p);
    tiffBuf.writeUInt16LE(type, p + 2);
    tiffBuf.writeUInt32LE(count, p + 4);
    tiffBuf.writeUInt32LE(val >>> 0, p + 8);
    p += 12;
  };
  writeIfdEntry(0x010f, 2, makeBytes.length, makeOffset);
  writeIfdEntry(0x0112, 3, 1, opts.orientation);
  writeIfdEntry(0x8769, 4, 1, exifIfdOffset);
  tiffBuf.writeUInt32LE(0, p);

  makeBytes.copy(tiffBuf, makeOffset);

  // ExifIFD
  p = exifIfdOffset;
  tiffBuf.writeUInt16LE(exifEntries.length, p);
  p += 2;
  for (const e of exifEntries) {
    writeIfdEntry(e.tag, e.type, e.count, e.val);
  }
  tiffBuf.writeUInt32LE(0, p);

  makerNote.copy(tiffBuf, makerNoteOffset);

  // Wrap TIFF in JPEG APP1 ("Exif\0\0") right after SOI (0xFFD8)
  const exifHeader = Buffer.from('Exif\0\0', 'ascii');
  const app1Payload = Buffer.concat([exifHeader, tiffBuf]);
  const app1Marker = Buffer.alloc(4);
  app1Marker.writeUInt16BE(0xffe1, 0);
  app1Marker.writeUInt16BE(app1Payload.length + 2, 2);

  return Buffer.concat([baseJpeg.subarray(0, 2), app1Marker, app1Payload, baseJpeg.subarray(2)]);
}

describe('Focus Point Extraction (Fujifilm .RAF & .JPG)', () => {
  test('applyExifOrientation transforms all 8 EXIF orientations accurately', () => {
    const nx = 0.25;
    const ny = 0.75;
    expect(applyExifOrientation(nx, ny, 1)).toEqual({ x: 0.25, y: 0.75 });
    expect(applyExifOrientation(nx, ny, 2)).toEqual({ x: 0.75, y: 0.75 });
    expect(applyExifOrientation(nx, ny, 3)).toEqual({ x: 0.75, y: 0.25 });
    expect(applyExifOrientation(nx, ny, 4)).toEqual({ x: 0.25, y: 0.25 });
    expect(applyExifOrientation(nx, ny, 5)).toEqual({ x: 0.75, y: 0.25 });
    expect(applyExifOrientation(nx, ny, 6)).toEqual({ x: 0.25, y: 0.25 });
    expect(applyExifOrientation(nx, ny, 7)).toEqual({ x: 0.25, y: 0.75 });
    expect(applyExifOrientation(nx, ny, 8)).toEqual({ x: 0.75, y: 0.75 });
  });

  test('extracts normalized upright focus points matching verified X-T5 .RAF test vectors', async () => {
    const vectors = [
      { name: 'xt5-110.RAF', orientation: 8, raw: [2053, 857] as [number, number], ux: 0.2911, uy: 0.5351 },
      { name: 'xt5-100.RAF', orientation: 8, raw: [3129, 1625] as [number, number], ux: 0.5520, uy: 0.2914 },
      { name: 'xt5-93.RAF', orientation: 8, raw: [2207, 2240] as [number, number], ux: 0.7609, uy: 0.5002 },
      { name: 'xt5-11.RAF', orientation: 1, raw: [1900, 2086] as [number, number], ux: 0.4303, uy: 0.7086 },
      { name: 'xt5-111.RAF', orientation: 1, raw: [2207, 1472] as [number, number], ux: 0.4998, uy: 0.5000 },
    ];

    for (const v of vectors) {
      const jpeg = buildFujifilmJpegWithFocus({
        jpegWidth: 320,
        jpegHeight: 216,
        orientation: v.orientation,
        exifImageWidth: 4416,
        exifImageHeight: 2944,
        focusPixel: v.raw,
        focusMode: 0,
        afMode: 1,
        focusSettings: 0x00006001, // AF-S, PreAF=Off, Single Point, PointSize=6
        focusWarning: 0,
      });
      const rafBytes = buildSyntheticRafRaw(jpeg);
      const rafPath = path.join(tmpDir, v.name);
      await fs.writeFile(rafPath, rafBytes);

      const idx = await indexPhotoFile(rafPath);
      expect(idx.exif.orientation).toBe(v.orientation);
      expect(idx.exif.focus).toBeDefined();
      expect(idx.exif.focus!.mode).toBe('AF-S');
      expect(idx.exif.focus!.areaMode).toBe('Single Point');
      expect(idx.exif.focus!.locked).toBe(true);
      expect(idx.exif.focus!.points).toHaveLength(1);
      expect(idx.exif.focus!.points[0].x).toBeCloseTo(v.ux, 4);
      expect(idx.exif.focus!.points[0].y).toBeCloseTo(v.uy, 4);
      expect(idx.exif.focus!.points[0].active).toBe(true);
      expect(idx.exif.focus!.points[0].kind).toBe('af-point');
    }
  });

  test('extracts focus point from out-of-camera Fujifilm .JPG and falls back to SOF dims when 0xA002/0xA003 absent', async () => {
    const jpg = buildFujifilmJpegWithFocus({
      jpegWidth: 640,
      jpegHeight: 424,
      orientation: 6, // Rotate 90 CW -> (1 - ny, nx)
      focusPixel: [160, 106], // nx = 0.25, ny = 0.25 -> upright (0.75, 0.25)
      focusMode: 0,
      afMode: 256,
      focusSettings: 0x00e70102, // AF-C, Zone
      focusWarning: 0,
    });
    const jpgPath = path.join(tmpDir, 'DSCF0200.JPG');
    await fs.writeFile(jpgPath, jpg);

    const idx = await indexPhotoFile(jpgPath);
    expect(idx.exif.focus).toBeDefined();
    expect(idx.exif.focus!.mode).toBe('AF-C');
    expect(idx.exif.focus!.areaMode).toBe('Zone');
    expect(idx.exif.focus!.points).toHaveLength(1);
    expect(idx.exif.focus!.points[0].x).toBeCloseTo(0.75, 4);
    expect(idx.exif.focus!.points[0].y).toBeCloseTo(0.25, 4);
    expect(idx.exif.focus!.points[0].kind).toBe('af-zone');
  });

  test('omits active focus point for manual focus and out-of-bounds / [0,0] coordinates', async () => {
    const mfJpeg = buildFujifilmJpegWithFocus({
      jpegWidth: 320,
      jpegHeight: 216,
      orientation: 1,
      exifImageWidth: 4416,
      exifImageHeight: 2944,
      focusPixel: [2207, 1472],
      focusMode: 1, // Manual
      focusSettings: 0x00000000, // MF
    });
    const mfPath = path.join(tmpDir, 'DSCF_MF.RAF');
    await fs.writeFile(mfPath, buildSyntheticRafRaw(mfJpeg));
    const mfIdx = await indexPhotoFile(mfPath);
    expect(mfIdx.exif.focus?.mode).toBe('MF');
    expect(mfIdx.exif.focus?.points).toEqual([]);

    const oobJpeg = buildFujifilmJpegWithFocus({
      jpegWidth: 320,
      jpegHeight: 216,
      orientation: 1,
      exifImageWidth: 4416,
      exifImageHeight: 2944,
      focusPixel: [5000, 1000], // out of bounds
      focusMode: 0,
      focusSettings: 0x00006001,
    });
    const oobPath = path.join(tmpDir, 'DSCF_OOB.RAF');
    await fs.writeFile(oobPath, buildSyntheticRafRaw(oobJpeg));
    const oobIdx = await indexPhotoFile(oobPath);
    expect(oobIdx.exif.focus?.points).toEqual([]);
  });
});
