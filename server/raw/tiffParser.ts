import type { ExifData } from '../../shared/types.js';
import {
  BinaryReader,
  readInt32,
  readUInt16,
  readUInt32,
  readUInt64AsNumber,
} from './binaryReader.js';
import { type JpegCandidate, probeJpegCandidate } from './jpegMeta.js';

export interface TiffParseResult {
  candidates: JpegCandidate[];
  exif: ExifData;
}

const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
  16: 8, // LONG8 (BigTIFF)
  17: 8, // SLONG8
  18: 8, // IFD8
};

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  valueOrOffset: number;
  inlineOffset: number; // absolute file offset of the inline value field
  totalBytes: number;
}

function formatShutterSpeed(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec >= 0.5) {
    return sec >= 10 ? `${Math.round(sec)}s` : `${Number(sec.toFixed(1))}s`;
  }
  const denom = Math.round(1 / sec);
  return `1/${denom}s`;
}

function cleanAscii(buf: Buffer): string {
  let end = buf.indexOf(0);
  if (end === -1) end = buf.length;
  return buf.subarray(0, end).toString('utf8').trim();
}

/**
 * Parses a TIFF-based container starting at `baseOffset` inside `reader`.
 * Supports standard TIFF (ARW, NEF, CR2, DNG, PEF, SRW, IIQ, 3FR, ERF),
 * Olympus ORF (magic 0x4F52 / 0x5352), Panasonic RW2 (magic 0x0055),
 * and BigTIFF (magic 0x002B).
 */
export async function parseTiffContainer(
  reader: BinaryReader,
  baseOffset = 0,
  options: { maxIfds?: number } = {},
): Promise<TiffParseResult> {
  const maxIfds = options.maxIfds ?? 48;
  const candidates: JpegCandidate[] = [];
  const exif: ExifData = {};

  const hdr = await reader.readSlice(baseOffset, 16);
  if (hdr.length < 8) return { candidates, exif };

  // Handle Minolta MRW wrapper ("\x00MRM" + 4-byte offset to raw data; TIFF is inside TTW block)
  if (hdr[0] === 0x00 && hdr[1] === 0x4d && hdr[2] === 0x52 && hdr[3] === 0x4d) {
    const dataOffset = hdr.readUInt32BE(4) + 8;
    let blockPos = 8;
    while (blockPos + 8 < dataOffset && blockPos + 8 < reader.fileSize) {
      const bHdr = await reader.readSlice(baseOffset + blockPos, 8);
      if (bHdr.length < 8) break;
      const tag = bHdr.subarray(0, 4).toString('ascii');
      const bLen = bHdr.readUInt32BE(4);
      if (tag === '\x00TTW') {
        return parseTiffContainer(reader, baseOffset + blockPos + 8, options);
      }
      blockPos += 8 + bLen;
    }
    return { candidates, exif };
  }

  const byteOrder = hdr.subarray(0, 2).toString('ascii');
  if (byteOrder !== 'II' && byteOrder !== 'MM') {
    return { candidates, exif };
  }
  const le = byteOrder === 'II';
  const magic = readUInt16(hdr, 2, le);

  const isStandardTiff = magic === 0x002a;
  const isOlympusOrf = magic === 0x4f52 || magic === 0x5352;
  const isPanasonicRw2 = magic === 0x0055;
  const isBigTiff = magic === 0x002b;

  if (!isStandardTiff && !isOlympusOrf && !isPanasonicRw2 && !isBigTiff) {
    return { candidates, exif };
  }

  let firstIfdOffset = 0;
  if (isBigTiff) {
    if (hdr.length < 16) return { candidates, exif };
    firstIfdOffset = readUInt64AsNumber(hdr, 8, le);
  } else {
    firstIfdOffset = readUInt32(hdr, 4, le);
  }

  const visitedIfds = new Set<number>();
  const queue: { relOffset: number; kind: string }[] = [{ relOffset: firstIfdOffset, kind: 'IFD0' }];

  const readEntryBytes = async (entry: IfdEntry): Promise<Buffer> => {
    const inlineLimit = isBigTiff ? 8 : 4;
    if (entry.totalBytes <= inlineLimit) {
      return reader.readSlice(entry.inlineOffset, entry.totalBytes);
    }
    return reader.readSlice(baseOffset + entry.valueOrOffset, entry.totalBytes);
  };

  const readUIntArray = async (entry: IfdEntry): Promise<number[]> => {
    if (entry.count === 0 || entry.count > 1024) return [];
    const buf = await readEntryBytes(entry);
    const out: number[] = [];
    const elemSize = TYPE_SIZES[entry.type] ?? 0;
    if (elemSize === 0) return [];

    for (let i = 0; i < entry.count; i++) {
      const off = i * elemSize;
      if (off + elemSize > buf.length) break;
      if (entry.type === 1) out.push(buf[off]);
      else if (entry.type === 3) out.push(readUInt16(buf, off, le));
      else if (entry.type === 4 || entry.type === 13) out.push(readUInt32(buf, off, le));
      else if (entry.type === 16 || entry.type === 18) out.push(readUInt64AsNumber(buf, off, le));
    }
    return out;
  };

  const readRational = async (entry: IfdEntry): Promise<number | null> => {
    const buf = await readEntryBytes(entry);
    if (buf.length < 8) return null;
    const isSigned = entry.type === 10;
    const num = isSigned ? readInt32(buf, 0, le) : readUInt32(buf, 0, le);
    const den = isSigned ? readInt32(buf, 4, le) : readUInt32(buf, 4, le);
    if (den === 0) return null;
    return num / den;
  };

  let ifdsProcessed = 0;

  while (queue.length > 0 && ifdsProcessed < maxIfds) {
    const nextItem = queue.shift()!;
    const relOffset = nextItem.relOffset;
    if (relOffset <= 0 || visitedIfds.has(relOffset)) continue;
    if (baseOffset + relOffset + 4 > reader.fileSize) continue;

    visitedIfds.add(relOffset);
    ifdsProcessed++;

    const absIfdOffset = baseOffset + relOffset;
    const countBytes = isBigTiff ? 8 : 2;
    const entrySize = isBigTiff ? 20 : 12;
    const nextPtrSize = isBigTiff ? 8 : 4;

    const countBuf = await reader.readSlice(absIfdOffset, countBytes);
    if (countBuf.length < countBytes) continue;
    const numEntries = isBigTiff
      ? readUInt64AsNumber(countBuf, 0, le)
      : readUInt16(countBuf, 0, le);

    if (numEntries <= 0 || numEntries > 512) continue;

    const tableBytes = numEntries * entrySize + nextPtrSize;
    const tableBuf = await reader.readSlice(absIfdOffset + countBytes, tableBytes);
    if (tableBuf.length < numEntries * entrySize) continue;

    const entries = new Map<number, IfdEntry>();
    for (let i = 0; i < numEntries; i++) {
      const eOff = i * entrySize;
      const tag = readUInt16(tableBuf, eOff, le);
      const type = readUInt16(tableBuf, eOff + 2, le);
      const count = isBigTiff
        ? readUInt64AsNumber(tableBuf, eOff + 4, le)
        : readUInt32(tableBuf, eOff + 4, le);
      const valFieldOff = isBigTiff ? eOff + 12 : eOff + 8;
      const valueOrOffset = isBigTiff
        ? readUInt64AsNumber(tableBuf, valFieldOff, le)
        : readUInt32(tableBuf, valFieldOff, le);
      const elemSize = TYPE_SIZES[type] ?? 1;

      entries.set(tag, {
        tag,
        type,
        count,
        valueOrOffset,
        inlineOffset: absIfdOffset + countBytes + valFieldOff,
        totalBytes: count * elemSize,
      });
    }

    // Queue next chained IFD (IFD1, IFD2, ...)
    if (tableBuf.length >= tableBytes) {
      const nextIfd = isBigTiff
        ? readUInt64AsNumber(tableBuf, numEntries * entrySize, le)
        : readUInt32(tableBuf, numEntries * entrySize, le);
      if (nextIfd > 0 && !visitedIfds.has(nextIfd)) {
        queue.push({ relOffset: nextIfd, kind: `${nextItem.kind}->next` });
      }
    }

    // Queue SubIFDs (0x014A) - where Nikon NEF, Sony ARW, DNG store full-size embedded previews!
    const subIfdEntry = entries.get(0x014a);
    if (subIfdEntry) {
      const offsets = await readUIntArray(subIfdEntry);
      for (let i = 0; i < offsets.length; i++) {
        if (offsets[i] > 0 && !visitedIfds.has(offsets[i])) {
          queue.push({ relOffset: offsets[i], kind: `${nextItem.kind}.SubIFD${i}` });
        }
      }
    }

    // Queue ExifIFD (0x8769)
    const exifIfdEntry = entries.get(0x8769);
    if (exifIfdEntry) {
      const vals = await readUIntArray(exifIfdEntry);
      if (vals[0] > 0 && !visitedIfds.has(vals[0])) {
        queue.push({ relOffset: vals[0], kind: 'ExifIFD' });
      }
    }

    // Extract JPEG candidate 1: JPEGInterchangeFormat (0x0201) + Length (0x0202)
    const jpgOffEntry = entries.get(0x0201);
    const jpgLenEntry = entries.get(0x0202);
    if (jpgOffEntry && jpgLenEntry) {
      const offs = await readUIntArray(jpgOffEntry);
      const lens = await readUIntArray(jpgLenEntry);
      if (offs[0] > 0 && lens[0] > 0) {
        const cand = await probeJpegCandidate(
          reader,
          baseOffset + offs[0],
          lens[0],
          `${nextItem.kind}:JPEGInterchange`,
        );
        if (cand) candidates.push(cand);
      }
    }

    // Extract JPEG candidate 2: StripOffsets (0x0111) + StripByteCounts (0x0117)
    // Canon CR2 IFD0 and some NEF/DNG previews store full JPEG in StripOffsets with Compression 6 or 7
    const stripOffEntry = entries.get(0x0111);
    const stripLenEntry = entries.get(0x0117);
    if (stripOffEntry && stripLenEntry) {
      const compEntry = entries.get(0x0103);
      const comp = compEntry ? (await readUIntArray(compEntry))[0] : undefined;
      // Check when compression is 6 (old JPEG), 7 (JPEG), or unspecified/single-strip
      if (comp === 6 || comp === 7 || comp === undefined || stripOffEntry.count === 1) {
        const offs = await readUIntArray(stripOffEntry);
        const lens = await readUIntArray(stripLenEntry);
        if (offs.length === 1 && lens.length === 1 && offs[0] > 0 && lens[0] > 1024) {
          const cand = await probeJpegCandidate(
            reader,
            baseOffset + offs[0],
            lens[0],
            `${nextItem.kind}:Strip`,
          );
          if (cand) candidates.push(cand);
        }
      }
    }

    // Extract JPEG candidate 3: Panasonic RW2 JpgFromRaw (0x002E)
    const rw2JpgEntry = entries.get(0x002e);
    if (rw2JpgEntry && rw2JpgEntry.totalBytes > 1024) {
      const cand = await probeJpegCandidate(
        reader,
        baseOffset + rw2JpgEntry.valueOrOffset,
        rw2JpgEntry.totalBytes,
        `${nextItem.kind}:RW2_JpgFromRaw`,
      );
      if (cand) candidates.push(cand);
    }

    // Extract JPEG candidate 4: Olympus MakerNote (0x927C) -> PreviewImageStart/Length or CameraSettings IFD
    const makerNoteEntry = entries.get(0x927c);
    if (makerNoteEntry && makerNoteEntry.totalBytes > 16) {
      const mnOffset = baseOffset + makerNoteEntry.valueOrOffset;
      await parseOlympusMakerNote(reader, mnOffset, makerNoteEntry.totalBytes, candidates);
    }

    // Extract EXIF Metadata tags
    if (!exif.make && entries.has(0x010f)) {
      const s = cleanAscii(await readEntryBytes(entries.get(0x010f)!));
      if (s) exif.make = s;
    }
    if (!exif.model && entries.has(0x0110)) {
      const s = cleanAscii(await readEntryBytes(entries.get(0x0110)!));
      if (s) exif.model = s;
    }
    if (!exif.orientation && entries.has(0x0112)) {
      const v = (await readUIntArray(entries.get(0x0112)!))[0];
      if (v >= 1 && v <= 8) exif.orientation = v;
    }
    if (!exif.lens && entries.has(0xa434)) {
      const s = cleanAscii(await readEntryBytes(entries.get(0xa434)!));
      if (s) exif.lens = s;
    }
    if (!exif.exposureTime && entries.has(0x829a)) {
      const sec = await readRational(entries.get(0x829a)!);
      if (sec !== null && sec > 0) {
        exif.exposureTimeSec = sec;
        exif.exposureTime = formatShutterSpeed(sec);
      }
    }
    if (!exif.fNumber && entries.has(0x829d)) {
      const f = await readRational(entries.get(0x829d)!);
      if (f !== null && f > 0) {
        exif.fNumber = Number(f.toFixed(1));
      }
    }
    if (!exif.iso && (entries.has(0x8827) || entries.has(0x8832))) {
      const entry = entries.get(0x8827) ?? entries.get(0x8832)!;
      const v = (await readUIntArray(entry))[0];
      if (v > 0) exif.iso = v;
    }
    if (!exif.focalLength && entries.has(0x920a)) {
      const fl = await readRational(entries.get(0x920a)!);
      if (fl !== null && fl > 0) {
        exif.focalLength = Number(fl.toFixed(1));
      }
    }
    if (!exif.focalLength35mm && entries.has(0xa405)) {
      const fl35 = (await readUIntArray(entries.get(0xa405)!))[0];
      if (fl35 > 0) exif.focalLength35mm = fl35;
    }
    if (!exif.dateTimeOriginal && (entries.has(0x9003) || entries.has(0x0132))) {
      const entry = entries.get(0x9003) ?? entries.get(0x0132)!;
      const s = cleanAscii(await readEntryBytes(entry));
      if (s) exif.dateTimeOriginal = s;
    }
  }

  return { candidates, exif };
}

/**
 * Parses Olympus / OM System MakerNote headers ("OLYMPUS\0II" or "OLYMP\0")
 * to locate embedded full-size PreviewImage inside ORF files.
 */
async function parseOlympusMakerNote(
  reader: BinaryReader,
  mnAbsOffset: number,
  mnLength: number,
  candidates: JpegCandidate[],
): Promise<void> {
  const head = await reader.readSlice(mnAbsOffset, Math.min(mnLength, 64));
  if (head.length < 16) return;

  let ifdStartInMn = -1;
  let offsetBase = mnAbsOffset;
  let le = true;

  // "OLYMPUS\0II\x03\x00" (12-byte header, offsets relative to mnAbsOffset)
  if (head.subarray(0, 8).toString('ascii') === 'OLYMPUS\0') {
    const bo = head.subarray(8, 10).toString('ascii');
    le = bo !== 'MM';
    ifdStartInMn = 12;
    offsetBase = mnAbsOffset;
  } else if (head.subarray(0, 6).toString('ascii') === 'OLYMP\0') {
    ifdStartInMn = 8;
    offsetBase = 0;
  } else {
    return;
  }

  const countBuf = await reader.readSlice(mnAbsOffset + ifdStartInMn, 2);
  if (countBuf.length < 2) return;
  const count = readUInt16(countBuf, 0, le);
  if (count <= 0 || count > 256) return;

  const entriesBuf = await reader.readSlice(mnAbsOffset + ifdStartInMn + 2, count * 12);
  let csOffset = 0;
  let previewStart = 0;
  let previewLen = 0;

  for (let i = 0; i < count; i++) {
    const off = i * 12;
    if (off + 12 > entriesBuf.length) break;
    const tag = readUInt16(entriesBuf, off, le);
    const val = readUInt32(entriesBuf, off + 8, le);
    if (tag === 0x2020) csOffset = val;
    else if (tag === 0x0101) previewStart = val;
    else if (tag === 0x0102) previewLen = val;
  }

  if (previewStart > 0 && previewLen > 1024) {
    const cand = await probeJpegCandidate(reader, offsetBase + previewStart, previewLen, 'OlympusMN:Preview');
    if (cand) candidates.push(cand);
  }

  // Olympus CameraSettings IFD (0x2020) contains PreviewImageStart (0x0101) & PreviewImageLength (0x0102)
  if (csOffset > 0) {
    const csAbs = offsetBase + csOffset;
    const csCountBuf = await reader.readSlice(csAbs, 2);
    if (csCountBuf.length === 2) {
      const csCount = readUInt16(csCountBuf, 0, le);
      if (csCount > 0 && csCount <= 256) {
        const csBuf = await reader.readSlice(csAbs + 2, csCount * 12);
        let pStart = 0;
        let pLen = 0;
        for (let i = 0; i < csCount; i++) {
          const off = i * 12;
          if (off + 12 > csBuf.length) break;
          const tag = readUInt16(csBuf, off, le);
          const val = readUInt32(csBuf, off + 8, le);
          if (tag === 0x0101) pStart = val;
          else if (tag === 0x0102) pLen = val;
        }
        if (pStart > 0 && pLen > 1024) {
          const cand = await probeJpegCandidate(reader, offsetBase + pStart, pLen, 'OlympusCS:Preview');
          if (cand) candidates.push(cand);
        }
      }
    }
  }
}
