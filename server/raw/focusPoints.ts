import type { FocusMetadata, FocusPoint } from '../../shared/types.js';
import type { BinaryReader } from './binaryReader.js';

/**
 * Transforms an unrotated normalized coordinate (nx, ny) in [0..1] x [0..1]
 * (origin top-left of sensor/preview image) into upright display space using
 * EXIF Orientation tag 0x0112 (1..8, default 1).
 */
export function applyExifOrientation(
  nx: number,
  ny: number,
  orientation = 1,
): { x: number; y: number } {
  switch (orientation) {
    case 2:
      return { x: 1 - nx, y: ny };
    case 3:
      return { x: 1 - nx, y: 1 - ny };
    case 4:
      return { x: nx, y: 1 - ny };
    case 5:
      return { x: ny, y: nx };
    case 6:
      return { x: 1 - ny, y: nx };
    case 7:
      return { x: 1 - ny, y: 1 - nx };
    case 8:
      return { x: ny, y: 1 - nx };
    case 1:
    default:
      return { x: nx, y: ny };
  }
}

export interface RawFujifilmFocus {
  rawX?: number;
  rawY?: number;
  focusMode?: number;     // 0x1021: 0=Auto, 1=Manual, 65535=Movie
  afMode?: number;        // 0x1022: 0=No, 1=Single Point, 256=Zone, 512=Wide/Tracking
  focusSettings?: number; // 0x102D: packed uint32 LE bitfield
  focusWarning?: number;  // 0x1301: 0=Good, 1=Out of focus
}

/**
 * Parses Fujifilm MakerNote IFD ("FUJIFILM" + uint32 LE relative IFD offset).
 * Fujifilm MakerNotes are always little-endian with offsets relative to mnAbsOffset.
 */
export async function parseFujifilmMakerNote(
  reader: BinaryReader,
  mnAbsOffset: number,
  mnLength: number,
): Promise<RawFujifilmFocus | null> {
  if (mnLength < 14) return null;

  const head = await reader.readSlice(mnAbsOffset, 12);
  if (head.length < 12) return null;
  if (head.subarray(0, 8).toString('ascii') !== 'FUJIFILM') {
    return null;
  }

  const ifdRel = head.readUInt32LE(8);
  if (ifdRel < 8 || ifdRel + 2 > mnLength) return null;

  const countBuf = await reader.readSlice(mnAbsOffset + ifdRel, 2);
  if (countBuf.length < 2) return null;
  const count = countBuf.readUInt16LE(0);
  if (count <= 0 || count > 512) return null;

  const entriesBytes = Math.min(count * 12, Math.max(0, mnLength - ifdRel - 2));
  const entriesBuf = await reader.readSlice(mnAbsOffset + ifdRel + 2, entriesBytes);

  const raw: RawFujifilmFocus = {};
  let foundAny = false;

  for (let i = 0; i < count; i++) {
    const off = i * 12;
    if (off + 12 > entriesBuf.length) break;

    const tag = entriesBuf.readUInt16LE(off);
    const type = entriesBuf.readUInt16LE(off + 2);
    const valCount = entriesBuf.readUInt32LE(off + 4);

    if (tag === 0x1021 && type === 3 && valCount >= 1) {
      raw.focusMode = entriesBuf.readUInt16LE(off + 8);
      foundAny = true;
    } else if (tag === 0x1022 && type === 3 && valCount >= 1) {
      raw.afMode = entriesBuf.readUInt16LE(off + 8);
      foundAny = true;
    } else if (tag === 0x1023 && type === 3 && valCount === 2) {
      // FocusPixel: 2 x uint16 LE stored inline in bytes 8..11
      raw.rawX = entriesBuf.readUInt16LE(off + 8);
      raw.rawY = entriesBuf.readUInt16LE(off + 10);
      foundAny = true;
    } else if (tag === 0x102d && type === 4 && valCount >= 1) {
      raw.focusSettings = entriesBuf.readUInt32LE(off + 8);
      foundAny = true;
    } else if (tag === 0x1301 && type === 3 && valCount >= 1) {
      raw.focusWarning = entriesBuf.readUInt16LE(off + 8);
      foundAny = true;
    }
  }

  return foundAny ? raw : null;
}

/**
 * Converts parsed Fujifilm MakerNote focus tags into normalized upright FocusMetadata
 * once IFD0 Orientation and ExifIFD reference dimensions are known.
 */
export function finalizeFujifilmFocus(
  raw: RawFujifilmFocus,
  refWidth: number,
  refHeight: number,
  orientation = 1,
): FocusMetadata | undefined {
  let mode: string | undefined;
  let areaMode: string | undefined;

  if (raw.focusSettings !== undefined) {
    const mode2 = raw.focusSettings & 0x0f;
    if (mode2 === 0) mode = 'MF';
    else if (mode2 === 1) mode = 'AF-S';
    else if (mode2 === 2) mode = 'AF-C';

    const area = (raw.focusSettings >> 8) & 0x0f;
    if (area === 0) areaMode = 'Single Point';
    else if (area === 1) areaMode = 'Zone';
    else if (area === 2) areaMode = 'Wide/Tracking';
  }

  if (!mode && raw.focusMode !== undefined) {
    if (raw.focusMode === 0) mode = 'AF';
    else if (raw.focusMode === 1) mode = 'MF';
    else if (raw.focusMode === 65535) mode = 'Movie';
  }

  if (!areaMode && raw.afMode !== undefined) {
    if (raw.afMode === 1) areaMode = 'Single Point';
    else if (raw.afMode === 256) areaMode = 'Zone';
    else if (raw.afMode === 512) areaMode = 'Wide/Tracking';
  }

  const isManual =
    raw.focusMode === 1 ||
    (raw.focusSettings !== undefined && (raw.focusSettings & 0x0f) === 0) ||
    (raw.afMode === 0 && raw.focusSettings === undefined);

  const locked = raw.focusWarning !== undefined ? raw.focusWarning === 0 : undefined;

  const points: FocusPoint[] = [];
  let rawDebug: FocusMetadata['raw'];

  if (
    !isManual &&
    raw.rawX !== undefined &&
    raw.rawY !== undefined &&
    refWidth > 0 &&
    refHeight > 0 &&
    !(raw.rawX === 0 && raw.rawY === 0) &&
    raw.rawX < refWidth &&
    raw.rawY < refHeight
  ) {
    const nx = raw.rawX / refWidth;
    const ny = raw.rawY / refHeight;
    const upright = applyExifOrientation(nx, ny, orientation);

    points.push({
      x: upright.x,
      y: upright.y,
      active: true,
      kind: areaMode === 'Zone' ? 'af-zone' : 'af-point',
    });

    rawDebug = {
      x: raw.rawX,
      y: raw.rawY,
      refWidth,
      refHeight,
      orientation,
    };
  }

  if (points.length === 0 && !mode && !areaMode && locked === undefined) {
    return undefined;
  }

  return {
    points,
    ...(mode ? { mode } : {}),
    ...(areaMode ? { areaMode } : {}),
    ...(locked !== undefined ? { locked } : {}),
    ...(rawDebug ? { raw: rawDebug } : {}),
  };
}
