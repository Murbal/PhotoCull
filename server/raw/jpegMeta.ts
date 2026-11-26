import type { BinaryReader } from './binaryReader.js';

export interface JpegDimensions {
  width: number;
  height: number;
}

export interface JpegCandidate {
  offset: number;
  length: number;
  width: number;
  height: number;
  source: string;
}

export function isJpegStart(buf: Buffer, offset = 0): boolean {
  return buf.length >= offset + 3 && buf[offset] === 0xff && buf[offset + 1] === 0xd8 && buf[offset + 2] === 0xff;
}

/**
 * Parses JPEG SOF0/SOF1/SOF2/SOF3 markers to extract exact pixel dimensions
 * without decoding the JPEG bitstream.
 */
export function parseJpegDimensionsFromBuffer(buf: Buffer): JpegDimensions | null {
  if (!isJpegStart(buf, 0)) return null;

  let pos = 2;
  const len = buf.length;

  while (pos + 4 <= len) {
    // Skip fill bytes (0xFF)
    while (pos < len && buf[pos] !== 0xff) pos++;
    while (pos < len && buf[pos] === 0xff) pos++;
    if (pos >= len) break;

    const marker = buf[pos++];

    // Standalone markers with no payload length
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      continue;
    }
    // Start of Scan - stop scanning headers
    if (marker === 0xda) break;

    if (pos + 2 > len) break;
    const segLen = buf.readUInt16BE(pos);
    if (segLen < 2) break;

    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSof && pos + 7 <= len) {
      const height = buf.readUInt16BE(pos + 3);
      const width = buf.readUInt16BE(pos + 5);
      if (width > 0 && height > 0) {
        return { width, height };
      }
      return null;
    }

    pos += segLen;
  }

  return null;
}

/**
 * Inspects up to 64 KB at a candidate JPEG offset to verify SOI magic and read dimensions.
 */
export async function probeJpegCandidate(
  reader: BinaryReader,
  offset: number,
  length: number,
  source: string,
): Promise<JpegCandidate | null> {
  if (offset < 0 || length < 128 || offset + 3 > reader.fileSize) return null;
  const clampedLength = Math.min(length, reader.fileSize - offset);
  const probeSize = Math.min(clampedLength, 65536);
  const head = await reader.readSlice(offset, probeSize);
  if (!isJpegStart(head, 0)) return null;

  let dims = parseJpegDimensionsFromBuffer(head);
  if (!dims && clampedLength > probeSize) {
    // Some JPEGs have a large APP1/APP2/ICC profile > 64KB before SOF0
    const biggerProbe = Math.min(clampedLength, 262144);
    const head2 = await reader.readSlice(offset, biggerProbe);
    dims = parseJpegDimensionsFromBuffer(head2);
  }

  return {
    offset,
    length: clampedLength,
    width: dims?.width ?? 0,
    height: dims?.height ?? 0,
    source,
  };
}

/**
 * Finds the EXIF APP1 TIFF payload (after "Exif\0\0") inside a JPEG buffer.
 * Returns { tiffOffsetInJpeg, tiffLength } or null.
 */
export function findJpegExifApp1(buf: Buffer): { offset: number; length: number } | null {
  if (!isJpegStart(buf, 0)) return null;
  let pos = 2;
  const len = buf.length;

  while (pos + 4 <= len) {
    while (pos < len && buf[pos] !== 0xff) pos++;
    while (pos < len && buf[pos] === 0xff) pos++;
    if (pos >= len) break;

    const marker = buf[pos++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;

    if (pos + 2 > len) break;
    const segLen = buf.readUInt16BE(pos);
    if (segLen < 2) break;

    // APP1 = 0xE1
    if (marker === 0xe1 && pos + 8 <= len) {
      if (
        buf[pos + 2] === 0x45 && // 'E'
        buf[pos + 3] === 0x78 && // 'x'
        buf[pos + 4] === 0x69 && // 'i'
        buf[pos + 5] === 0x66 && // 'f'
        buf[pos + 6] === 0x00 &&
        buf[pos + 7] === 0x00
      ) {
        const tiffStart = pos + 8;
        const tiffLen = Math.min(segLen - 8, len - tiffStart);
        if (tiffLen >= 8) {
          return { offset: tiffStart, length: tiffLen };
        }
      }
    }

    pos += segLen;
  }

  return null;
}

/**
 * Pick best full preview (largest pixel area, fallback to largest byte length)
 * and best thumbnail (preferring smallest candidate >= 240px wide, or smallest >= 120px, else full).
 */
export function selectBestPreviewAndThumb(candidates: JpegCandidate[]): {
  preview: JpegCandidate | null;
  thumbnail: JpegCandidate | null;
} {
  if (candidates.length === 0) return { preview: null, thumbnail: null };

  // Deduplicate by offset
  const uniqueMap = new Map<number, JpegCandidate>();
  for (const c of candidates) {
    const existing = uniqueMap.get(c.offset);
    if (!existing || c.length > existing.length) {
      uniqueMap.set(c.offset, c);
    }
  }
  const unique = Array.from(uniqueMap.values());

  // Sort descending by pixel area, then byte length
  const sortedDesc = [...unique].sort((a, b) => {
    const areaA = a.width * a.height;
    const areaB = b.width * b.height;
    if (areaA !== areaB) return areaB - areaA;
    return b.length - a.length;
  });

  const preview = sortedDesc[0] ?? null;

  // For contact sheet thumbnails, prefer a medium/small JPEG between 280px and 1920px wide
  // so grid thumbnails look crisp on HiDPI screens while loading in <1ms.
  const mediumCandidates = unique
    .filter((c) => {
      const longEdge = Math.max(c.width, c.height);
      return longEdge >= 280 && longEdge <= 2000;
    })
    .sort((a, b) => a.length - b.length);

  if (mediumCandidates.length > 0) {
    return { preview, thumbnail: mediumCandidates[0] };
  }

  // Otherwise pick smallest candidate that is still reasonably sharp (>= 160px) or fallback to preview
  const smallCandidates = unique
    .filter((c) => Math.max(c.width, c.height) >= 160 || c.length >= 8192)
    .sort((a, b) => a.length - b.length);

  return {
    preview,
    thumbnail: smallCandidates[0] ?? preview,
  };
}
