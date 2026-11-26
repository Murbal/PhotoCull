import type { ExifData } from '../../shared/types.js';

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export function formatExifStrip(exif?: ExifData): string[] {
  if (!exif) return [];
  const parts: string[] = [];
  if (exif.exposureTime) parts.push(exif.exposureTime);
  if (exif.fNumber) parts.push(`f/${exif.fNumber}`);
  if (exif.iso) parts.push(`ISO ${exif.iso}`);
  if (exif.focalLength) {
    parts.push(
      exif.focalLength35mm && exif.focalLength35mm !== Math.round(exif.focalLength)
        ? `${exif.focalLength}mm (${exif.focalLength35mm}mm eq)`
        : `${exif.focalLength}mm`,
    );
  }
  if (exif.lens) parts.push(exif.lens);
  else if (exif.model) parts.push(exif.model);
  return parts;
}
