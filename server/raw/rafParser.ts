import type { ExifData } from '../../shared/types.js';
import { BinaryReader } from './binaryReader.js';
import {
  findJpegExifApp1,
  type JpegCandidate,
  probeJpegCandidate,
} from './jpegMeta.js';
import { parseTiffContainer } from './tiffParser.js';

export interface RafParseResult {
  candidates: JpegCandidate[];
  exif: ExifData;
}

const RAF_MAGIC = 'FUJIFILMCCD-RAW ';

/**
 * Native Fujifilm .RAF parser.
 * Header layout (big-endian):
 * - 0x00..0x0F: "FUJIFILMCCD-RAW " (16 bytes)
 * - 0x54..0x57: JPEG preview offset (uint32 BE)
 * - 0x58..0x5B: JPEG preview length (uint32 BE)
 * Also extracts EXIF metadata and IFD1 thumbnail from the embedded JPEG's APP1 segment.
 */
export async function parseRafContainer(reader: BinaryReader): Promise<RafParseResult> {
  const candidates: JpegCandidate[] = [];
  let exif: ExifData = {};

  const hdr = await reader.readSlice(0, 128);
  if (hdr.length < 96) return { candidates, exif };
  if (hdr.subarray(0, 16).toString('ascii') !== RAF_MAGIC) {
    return { candidates, exif };
  }

  const jpegOffset = hdr.readUInt32BE(0x54);
  const jpegLength = hdr.readUInt32BE(0x58);

  if (jpegOffset > 0 && jpegLength > 128 && jpegOffset + jpegLength <= reader.fileSize) {
    const mainCand = await probeJpegCandidate(reader, jpegOffset, jpegLength, 'RAF:EmbeddedJPEG');
    if (mainCand) {
      candidates.push(mainCand);
    }

    // Parse EXIF & embedded thumbnail inside the JPEG's APP1 segment
    const jpegHead = await reader.readSlice(jpegOffset, Math.min(jpegLength, 131072));
    const app1 = findJpegExifApp1(jpegHead);
    if (app1) {
      const tiffRes = await parseTiffContainer(reader, jpegOffset + app1.offset, { maxIfds: 8 });
      exif = tiffRes.exif;
      // Embedded IFD1 thumbnail inside APP1 makes contact sheet thumbnails ultra-fast
      for (const c of tiffRes.candidates) {
        candidates.push({ ...c, source: `RAF:APP1:${c.source}` });
      }
    }
  }

  return { candidates, exif };
}
