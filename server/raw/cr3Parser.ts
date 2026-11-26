import type { ExifData } from '../../shared/types.js';
import { BinaryReader } from './binaryReader.js';
import { type JpegCandidate, probeJpegCandidate } from './jpegMeta.js';
import { parseTiffContainer } from './tiffParser.js';

export interface Cr3ParseResult {
  candidates: JpegCandidate[];
  exif: ExifData;
}

// Canon CR3 UUIDs
const CANON_MOOV_UUID = '85c0b687820f11e08111f4ce462b6a48';
const CANON_PRVW_UUID = 'eaf42b5e1c984b88b9fbb7dc406e4d16';

interface IsoBox {
  type: string;
  offset: number;       // start of box header
  dataOffset: number;   // start of box payload
  size: number;         // total box size
  end: number;          // offset + size
}

async function readBoxesInRange(
  reader: BinaryReader,
  start: number,
  end: number,
  maxBoxes = 128,
): Promise<IsoBox[]> {
  const boxes: IsoBox[] = [];
  let pos = start;

  while (pos + 8 <= end && boxes.length < maxBoxes) {
    const hdr = await reader.readSlice(pos, 16);
    if (hdr.length < 8) break;

    let size = hdr.readUInt32BE(0);
    const type = hdr.subarray(4, 8).toString('latin1');
    let headerSize = 8;

    if (size === 1) {
      if (hdr.length < 16) break;
      size = Number(hdr.readBigUInt64BE(8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }

    if (size < headerSize || pos + size > end + 1) break;
    const clampedEnd = Math.min(pos + size, end);
    boxes.push({
      type,
      offset: pos,
      dataOffset: pos + headerSize,
      size: clampedEnd - pos,
      end: clampedEnd,
    });
    pos = clampedEnd;
  }

  return boxes;
}

function mergeExif(target: ExifData, incoming: ExifData): void {
  if (!target.make && incoming.make) target.make = incoming.make;
  if (!target.model && incoming.model) target.model = incoming.model;
  if (!target.lens && incoming.lens) target.lens = incoming.lens;
  if (!target.exposureTime && incoming.exposureTime) {
    target.exposureTime = incoming.exposureTime;
    target.exposureTimeSec = incoming.exposureTimeSec;
  }
  if (!target.fNumber && incoming.fNumber) target.fNumber = incoming.fNumber;
  if (!target.iso && incoming.iso) target.iso = incoming.iso;
  if (!target.focalLength && incoming.focalLength) target.focalLength = incoming.focalLength;
  if (!target.focalLength35mm && incoming.focalLength35mm) target.focalLength35mm = incoming.focalLength35mm;
  if (!target.dateTimeOriginal && incoming.dateTimeOriginal) target.dateTimeOriginal = incoming.dateTimeOriginal;
  if (!target.orientation && incoming.orientation) target.orientation = incoming.orientation;
}

/**
 * Native Canon .CR3 (ISOBMFF / ISO Base Media File Format) parser.
 * Extracts:
 * - Track 1 full-resolution embedded JPEG inside `mdat` via `moov/trak/mdia/minf/stbl/(stco|co64 + stsz)`
 * - Medium preview JPEG inside top-level Canon `uuid` -> `PRVW` box
 * - Thumbnail JPEG inside `moov/uuid` -> `THMB` box
 * - Complete EXIF metadata from `CMT1` (IFD0) and `CMT2` (ExifIFD) TIFF blocks inside `moov/uuid`
 */
export async function parseCr3Container(reader: BinaryReader): Promise<Cr3ParseResult> {
  const candidates: JpegCandidate[] = [];
  const exif: ExifData = {};

  const topBoxes = await readBoxesInRange(reader, 0, reader.fileSize, 64);

  for (const box of topBoxes) {
    if (box.type === 'moov') {
      const moovChildren = await readBoxesInRange(reader, box.dataOffset, box.end, 64);
      for (const child of moovChildren) {
        if (child.type === 'uuid') {
          await parseCanonUuidBox(reader, child, candidates, exif);
        } else if (child.type === 'trak') {
          await parseCr3TrackBox(reader, child, candidates);
        }
      }
    } else if (box.type === 'uuid') {
      await parseCanonUuidBox(reader, box, candidates, exif);
    }
  }

  return { candidates, exif };
}

async function parseCanonUuidBox(
  reader: BinaryReader,
  box: IsoBox,
  candidates: JpegCandidate[],
  exif: ExifData,
): Promise<void> {
  if (box.end - box.dataOffset < 16) return;
  const uuidBuf = await reader.readSlice(box.dataOffset, 16);
  const uuidHex = uuidBuf.toString('hex').toLowerCase();

  if (uuidHex === CANON_MOOV_UUID) {
    // Sub-boxes: CMT1 (IFD0), CMT2 (ExifIFD), THMB (thumbnail JPEG), CNCV, etc.
    const subBoxes = await readBoxesInRange(reader, box.dataOffset + 16, box.end, 64);
    for (const sub of subBoxes) {
      if (sub.type === 'CMT1' || sub.type === 'CMT2') {
        const res = await parseTiffContainer(reader, sub.dataOffset, { maxIfds: 8 });
        mergeExif(exif, res.exif);
        candidates.push(...res.candidates);
      } else if (sub.type === 'THMB') {
        // THMB header: 4 bytes version/flags + 2 width + 2 height + 4 jpegSize + 4 reserved = 16 bytes
        const thmbHdr = await reader.readSlice(sub.dataOffset, 24);
        if (thmbHdr.length >= 16) {
          const jpegSize = thmbHdr.readUInt32BE(8);
          const jpgOff = sub.dataOffset + 16;
          if (jpegSize > 128 && jpgOff + jpegSize <= sub.end) {
            const cand = await probeJpegCandidate(reader, jpgOff, jpegSize, 'CR3:THMB');
            if (cand) candidates.push(cand);
          } else {
            // Fallback: scan first 32 bytes inside THMB for SOI (FF D8 FF)
            const soiPos = thmbHdr.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
            if (soiPos >= 0) {
              const cand = await probeJpegCandidate(
                reader,
                sub.dataOffset + soiPos,
                sub.end - (sub.dataOffset + soiPos),
                'CR3:THMB_scan',
              );
              if (cand) candidates.push(cand);
            }
          }
        }
      }
    }
  } else if (uuidHex === CANON_PRVW_UUID) {
    // Top-level preview UUID contains a 8-byte padding/header then `PRVW` box
    // Try direct sub-boxes at +16 or +24 (Canon adds 8-byte version/flags before PRVW in some cameras)
    for (const extraSkip of [0, 8]) {
      const subBoxes = await readBoxesInRange(reader, box.dataOffset + 16 + extraSkip, box.end, 16);
      const prvw = subBoxes.find((b) => b.type === 'PRVW');
      if (prvw) {
        // PRVW payload: 4 bytes (0,0,0,0) + 2 bytes (0x0001) + 2 bytes width + 2 bytes height + 2 bytes (0) + 4 bytes jpegSize = 16 bytes
        const pHdr = await reader.readSlice(prvw.dataOffset, 32);
        const soiPos = pHdr.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
        if (soiPos >= 0) {
          const jpgOff = prvw.dataOffset + soiPos;
          const jpgLen = prvw.end - jpgOff;
          const cand = await probeJpegCandidate(reader, jpgOff, jpgLen, 'CR3:PRVW');
          if (cand) candidates.push(cand);
        }
        break;
      }
    }
  }
}

async function parseCr3TrackBox(
  reader: BinaryReader,
  trakBox: IsoBox,
  candidates: JpegCandidate[],
): Promise<void> {
  const trakChildren = await readBoxesInRange(reader, trakBox.dataOffset, trakBox.end, 32);
  const mdia = trakChildren.find((b) => b.type === 'mdia');
  if (!mdia) return;

  const mdiaChildren = await readBoxesInRange(reader, mdia.dataOffset, mdia.end, 32);
  const minf = mdiaChildren.find((b) => b.type === 'minf');
  if (!minf) return;

  const minfChildren = await readBoxesInRange(reader, minf.dataOffset, minf.end, 32);
  const stbl = minfChildren.find((b) => b.type === 'stbl');
  if (!stbl) return;

  const stblChildren = await readBoxesInRange(reader, stbl.dataOffset, stbl.end, 32);
  const stsz = stblChildren.find((b) => b.type === 'stsz');
  const stco = stblChildren.find((b) => b.type === 'stco');
  const co64 = stblChildren.find((b) => b.type === 'co64');

  if (!stsz || (!stco && !co64)) return;

  // Read sample size from stsz
  const stszBuf = await reader.readSlice(stsz.dataOffset, Math.min(stsz.end - stsz.dataOffset, 24));
  if (stszBuf.length < 12) return;
  const uniformSampleSize = stszBuf.readUInt32BE(4);
  const sampleCount = stszBuf.readUInt32BE(8);
  if (sampleCount === 0) return;

  let sampleSize = uniformSampleSize;
  if (sampleSize === 0 && stszBuf.length >= 16) {
    sampleSize = stszBuf.readUInt32BE(12);
  }
  if (sampleSize < 1024) return;

  // Read chunk offset from stco (32-bit) or co64 (64-bit)
  let chunkOffset = 0;
  if (co64) {
    const coBuf = await reader.readSlice(co64.dataOffset, 16);
    if (coBuf.length >= 16) {
      const entryCount = coBuf.readUInt32BE(4);
      if (entryCount > 0) chunkOffset = Number(coBuf.readBigUInt64BE(8));
    }
  } else if (stco) {
    const coBuf = await reader.readSlice(stco.dataOffset, 12);
    if (coBuf.length >= 12) {
      const entryCount = coBuf.readUInt32BE(4);
      if (entryCount > 0) chunkOffset = coBuf.readUInt32BE(8);
    }
  }

  if (chunkOffset > 0 && chunkOffset + sampleSize <= reader.fileSize) {
    // Track 1 in CR3 holds the full-resolution JPEG! Verify SOI (FF D8 FF)
    const cand = await probeJpegCandidate(reader, chunkOffset, sampleSize, 'CR3:TrackFullJPEG');
    if (cand) candidates.push(cand);
  }
}
