import fs from 'node:fs/promises';
import path from 'node:path';
import type { PhotoMetadata } from '../shared/types.js';

const NS_XMP = 'http://ns.adobe.com/xap/1.0/';

function extractAttrOrElement(xml: string, attrName: string): string | null {
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attrRegex = new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const attrMatch = xml.match(attrRegex);
  if (attrMatch) {
    return (attrMatch[1] ?? attrMatch[2] ?? '').trim();
  }
  const elemRegex = new RegExp(`<${escaped}(?:\\s[^>]*)?>([^<]*)</${escaped}>`, 'i');
  const elemMatch = xml.match(elemRegex);
  if (elemMatch) {
    return elemMatch[1].trim();
  }
  return null;
}

/**
 * Parses standard Adobe XMP sidecar XML for `xmp:Rating` (0..5).
 * Directly compatible with Lightroom Classic, Capture One, Darktable, and Adobe Bridge.
 */
export function parseXmpContent(xml: string): PhotoMetadata {
  let rating = 0;

  const ratingStr = extractAttrOrElement(xml, 'xmp:Rating');
  if (ratingStr !== null && ratingStr !== '') {
    const num = Number.parseInt(ratingStr, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= 5) {
      rating = num;
    }
  }

  return {
    rating,
    hasXmp: true,
  };
}

function buildFreshXmp(rating: number): string {
  const attrs: string[] = ['rdf:about=""', `xmlns:xmp="${NS_XMP}"`];
  if (rating >= 1 && rating <= 5) {
    attrs.push(`xmp:Rating="${rating}"`);
  }

  const attrBlock = attrs.map((a) => `      ${a}`).join('\n');

  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="PhotoCull 0.1">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
${attrBlock}
    />
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

/**
 * Surgically updates ONLY `xmp:Rating` in an existing XMP XML string without clobbering
 * any existing Lightroom (`crs:*`), Darktable (`darktable:*`), Capture One, IPTC, or keyword fields.
 */
export function patchXmpContent(existingXml: string | null, rating: number): string {
  const clamped = Math.max(0, Math.min(5, Math.round(rating)));

  if (!existingXml || !/<rdf:Description\b/i.test(existingXml)) {
    return buildFreshXmp(clamped);
  }

  let xml = existingXml;

  const descRegex = /<rdf:Description\b([\s\S]*?)(\/?)>/i;
  const match = xml.match(descRegex);
  if (!match) {
    return buildFreshXmp(clamped);
  }

  let attrsPart = match[1];
  const selfClosing = match[2];

  if (!/\bxmlns:xmp\s*=/i.test(xml)) {
    attrsPart += `\n      xmlns:xmp="${NS_XMP}"`;
  }

  // Remove child element form if present to prevent conflicting duplicates
  xml = xml.replace(/\s*<xmp:Rating(?:\s[^>]*)?>[^<]*<\/xmp:Rating>/gi, '');

  const attrRegex = /(\s+)xmp:Rating\s*=\s*(?:"[^"]*"|'[^']*')/gi;
  if (clamped === 0) {
    attrsPart = attrsPart.replace(attrRegex, '');
  } else if (attrRegex.test(attrsPart)) {
    attrsPart = attrsPart.replace(attrRegex, `$1xmp:Rating="${clamped}"`);
  } else {
    attrsPart += `\n      xmp:Rating="${clamped}"`;
  }

  return xml.replace(descRegex, `<rdf:Description${attrsPart}${selfClosing}>`);
}

/**
 * Resolves the sidecar path for a photo in `folder`.
 * Checks `<baseName>.xmp` first (Lightroom/Capture One standard), then `<primaryFile>.xmp` (Darktable convention).
 */
export async function resolveXmpPath(
  folder: string,
  baseName: string,
  primaryFile: string,
): Promise<{ path: string; exists: boolean }> {
  const standardPath = path.join(folder, `${baseName}.xmp`);
  try {
    await fs.access(standardPath);
    return { path: standardPath, exists: true };
  } catch {
    const dtPath = path.join(folder, `${primaryFile}.xmp`);
    try {
      await fs.access(dtPath);
      return { path: dtPath, exists: true };
    } catch {
      return { path: standardPath, exists: false };
    }
  }
}

export async function readXmpFile(xmpPath: string): Promise<PhotoMetadata> {
  const xml = await fs.readFile(xmpPath, 'utf8');
  return parseXmpContent(xml);
}

/**
 * Atomically writes updated `xmp:Rating` to the `.xmp` sidecar file.
 */
export async function writeXmpMetadata(
  folder: string,
  baseName: string,
  primaryFile: string,
  rating: number,
): Promise<PhotoMetadata> {
  const clamped = Math.max(0, Math.min(5, Math.round(rating)));
  const { path: xmpPath, exists } = await resolveXmpPath(folder, baseName, primaryFile);
  let existingXml: string | null = null;
  if (exists) {
    try {
      existingXml = await fs.readFile(xmpPath, 'utf8');
    } catch {
      existingXml = null;
    }
  }

  const nextXml = patchXmpContent(existingXml, clamped);
  const tmpPath = `${xmpPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, nextXml, 'utf8');
  await fs.rename(tmpPath, xmpPath);

  return {
    rating: clamped,
    hasXmp: true,
  };
}
