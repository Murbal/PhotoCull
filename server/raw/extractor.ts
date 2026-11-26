import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExifData } from '../../shared/types.js';
import { RAW_EXTENSIONS } from '../../shared/types.js';
import { BinaryReader } from './binaryReader.js';
import {
  findJpegExifApp1,
  type JpegCandidate,
  parseJpegDimensionsFromBuffer,
  selectBestPreviewAndThumb,
} from './jpegMeta.js';
import { parseTiffContainer } from './tiffParser.js';
import { parseCr3Container } from './cr3Parser.js';
import { parseRafContainer } from './rafParser.js';

export interface ExtractedPhotoIndex {
  filePath: string;
  mtimeMs: number;
  fileSize: number;
  isRaw: boolean;
  mimeType: string;
  preview: JpegCandidate | null;
  thumbnail: JpegCandidate | null;
  exif: ExifData;
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly maxEntries: number) {}

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: K, val: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
  }
}

// Cache up to 20,000 parsed photo header indices in memory (~4 MB RAM total)
const indexCache = new LruCache<string, ExtractedPhotoIndex>(20000);
// In-flight deduplication so rapid parallel requests for the same file only parse once
const inflightIndex = new Map<string, Promise<ExtractedPhotoIndex>>();

export function getMimeTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'image/jpeg';
}

/**
 * Parses a RAW or standard image file using positional reads (`pread`) to locate:
 * 1. The largest embedded JPEG preview `(offset, length)`
 * 2. The optimal fast Contact Sheet thumbnail `(offset, length)`
 * 3. EXIF metadata (camera, lens, shutter, aperture, ISO, focal length, date, orientation, dimensions)
 */
export async function indexPhotoFile(filePath: string, knownMtimeMs?: number): Promise<ExtractedPhotoIndex> {
  let mtimeMs = knownMtimeMs;
  let fileSize = 0;

  if (mtimeMs === undefined) {
    const stat = await fs.stat(filePath);
    mtimeMs = stat.mtimeMs;
    fileSize = stat.size;
  }

  const cacheKey = `${filePath}::${mtimeMs}`;
  const cached = indexCache.get(cacheKey);
  if (cached) return cached;

  const existingPromise = inflightIndex.get(cacheKey);
  if (existingPromise) return existingPromise;

  const promise = (async () => {
    const fh = await fs.open(filePath, 'r');
    try {
      if (fileSize === 0) {
        const stat = await fh.stat();
        fileSize = stat.size;
        mtimeMs = stat.mtimeMs;
      }

      const ext = path.extname(filePath).toLowerCase();
      const isRaw = RAW_EXTENSIONS.has(ext);
      const reader = await BinaryReader.fromFileHandle(fh, fileSize);
      const magic = await reader.readSlice(0, 16);

      let candidates: JpegCandidate[] = [];
      let exif: ExifData = {};

      if (isRaw) {
        // 1. Fujifilm RAF
        if (magic.length >= 16 && magic.subarray(0, 16).toString('ascii') === 'FUJIFILMCCD-RAW ') {
          const res = await parseRafContainer(reader);
          candidates = res.candidates;
          exif = res.exif;
        }
        // 2. Canon CR3 (ISOBMFF: offset 4..8 == 'ftyp')
        else if (magic.length >= 12 && magic.subarray(4, 8).toString('ascii') === 'ftyp') {
          const res = await parseCr3Container(reader);
          candidates = res.candidates;
          exif = res.exif;
        }
        // 3. TIFF-based RAW (ARW, NEF, CR2, DNG, ORF, RW2, PEF, SRW, IIQ, 3FR, ERF, MRW)
        else {
          const res = await parseTiffContainer(reader, 0);
          candidates = res.candidates;
          exif = res.exif;
        }

        const { preview, thumbnail } = selectBestPreviewAndThumb(candidates);
        if (preview && preview.width > 0 && preview.height > 0) {
          exif.width = preview.width;
          exif.height = preview.height;
        }

        const result: ExtractedPhotoIndex = {
          filePath,
          mtimeMs: mtimeMs!,
          fileSize,
          isRaw: true,
          mimeType: 'image/jpeg',
          preview,
          thumbnail,
          exif,
        };
        indexCache.set(cacheKey, result);
        return result;
      }

      // Standard image formats (JPEG, PNG, WebP, etc.)
      if (ext === '.jpg' || ext === '.jpeg') {
        const head = await reader.readSlice(0, Math.min(fileSize, 131072));
        const dims = parseJpegDimensionsFromBuffer(head);
        if (dims) {
          exif.width = dims.width;
          exif.height = dims.height;
        }
        const app1 = findJpegExifApp1(head);
        if (app1) {
          const tiffRes = await parseTiffContainer(reader, app1.offset, {
            maxIfds: 8,
            fallbackRefWidth: dims?.width,
            fallbackRefHeight: dims?.height,
          });
          exif = { ...tiffRes.exif, width: exif.width, height: exif.height };
          candidates = tiffRes.candidates;
        }

        // Only use embedded EXIF thumbnail if it's sharp enough (>= 240px) — tiny 160x120 EXIF thumbs look blurry on HiDPI grids
        const sharpThumb = candidates
          .filter((c) => Math.max(c.width, c.height) >= 240)
          .sort((a, b) => a.length - b.length)[0] ?? null;

        const fullFileCandidate: JpegCandidate = {
          offset: 0,
          length: fileSize,
          width: exif.width ?? 0,
          height: exif.height ?? 0,
          source: 'JPEG:File',
        };

        const result: ExtractedPhotoIndex = {
          filePath,
          mtimeMs: mtimeMs!,
          fileSize,
          isRaw: false,
          mimeType: 'image/jpeg',
          preview: fullFileCandidate,
          thumbnail: sharpThumb ?? fullFileCandidate,
          exif,
        };
        indexCache.set(cacheKey, result);
        return result;
      }

      // PNG dimensions from IHDR (bytes 16..24)
      if (ext === '.png' && magic.length >= 16) {
        const ihdr = await reader.readSlice(0, 24);
        if (ihdr.length >= 24 && ihdr[0] === 0x89 && ihdr[1] === 0x50) {
          exif.width = ihdr.readUInt32BE(16);
          exif.height = ihdr.readUInt32BE(20);
        }
      }

      const result: ExtractedPhotoIndex = {
        filePath,
        mtimeMs: mtimeMs!,
        fileSize,
        isRaw: false,
        mimeType: getMimeTypeForFile(filePath),
        preview: { offset: 0, length: fileSize, width: exif.width ?? 0, height: exif.height ?? 0, source: 'Image:File' },
        thumbnail: { offset: 0, length: fileSize, width: exif.width ?? 0, height: exif.height ?? 0, source: 'Image:File' },
        exif,
      };
      indexCache.set(cacheKey, result);
      return result;
    } finally {
      await fh.close();
      inflightIndex.delete(cacheKey);
    }
  })();

  inflightIndex.set(cacheKey, promise);
  return promise;
}

/**
 * Extracts raw preview or thumbnail bytes directly via positional read (`pread`).
 * Never reads the full 50MB RAW sensor payload!
 */
export async function readPhotoImageBytes(
  filePath: string,
  variant: 'preview' | 'thumb',
): Promise<{ bytes: Buffer; mimeType: string; orientation: number; width: number; height: number } | null> {
  const index = await indexPhotoFile(filePath);
  const target = variant === 'thumb' ? (index.thumbnail ?? index.preview) : (index.preview ?? index.thumbnail);

  if (!target || target.length <= 0) {
    return null;
  }

  // Fast path: if full file is a standard image
  if (!index.isRaw && target.offset === 0 && target.length === index.fileSize) {
    const bytes = await fs.readFile(filePath);
    return {
      bytes,
      mimeType: index.mimeType,
      orientation: index.exif.orientation ?? 1,
      width: index.exif.width ?? target.width,
      height: index.exif.height ?? target.height,
    };
  }

  // Positional pread of exact embedded JPEG bytes
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(target.length);
    let totalRead = 0;
    while (totalRead < target.length) {
      const { bytesRead } = await fh.read(buf, totalRead, target.length - totalRead, target.offset + totalRead);
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
    const bytes = totalRead === target.length ? buf : buf.subarray(0, totalRead);
    return {
      bytes,
      mimeType: index.mimeType,
      orientation: index.exif.orientation ?? 1,
      width: target.width || index.exif.width || 0,
      height: target.height || index.exif.height || 0,
    };
  } finally {
    await fh.close();
  }
}
