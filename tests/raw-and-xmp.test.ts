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
