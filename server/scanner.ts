import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type BrowseResult,
  type DirectoryEntry,
  type FolderScanResult,
  IMAGE_EXTENSIONS,
  type PhotoItem,
  type PhotoMetadata,
  RAW_EXTENSIONS,
} from '../shared/types.js';
import { readXmpFile } from './xmp.js';

const DEFAULT_METADATA: PhotoMetadata = {
  rating: 0,
  hasXmp: false,
};

function isPhotoExtension(ext: string): boolean {
  return RAW_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext);
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const current = idx++;
      await worker(items[current]);
    }
  });
  await Promise.all(runners);
}

/**
 * Scans a local folder directly (zero catalog / import step).
 * Optionally pairs RAW + JPEG files with matching basenames into single logical items.
 * Reads existing `.xmp` sidecars in parallel (zero extra syscalls for files without `.xmp`).
 */
export async function scanFolder(folderPath: string, pairingEnabled = true): Promise<FolderScanResult> {
  const start = performance.now();
  const resolvedFolder = path.resolve(folderPath);
  const entries = await fs.readdir(resolvedFolder, { withFileTypes: true });

  // Track existing .xmp files by lowercase filename for O(1) lookup
  const xmpByLower = new Map<string, string>();
  const rawEntries: { name: string; baseName: string; baseLower: string; ext: string }[] = [];
  const imgEntries: { name: string; baseName: string; baseLower: string; ext: string }[] = [];

  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    if (name.startsWith('._') || name.startsWith('.')) continue;

    const ext = path.extname(name).toLowerCase();
    if (ext === '.xmp') {
      xmpByLower.set(name.toLowerCase(), name);
      continue;
    }

    if (RAW_EXTENSIONS.has(ext)) {
      const baseName = name.slice(0, name.length - ext.length);
      rawEntries.push({ name, baseName, baseLower: baseName.toLowerCase(), ext });
    } else if (IMAGE_EXTENSIONS.has(ext)) {
      const baseName = name.slice(0, name.length - ext.length);
      imgEntries.push({ name, baseName, baseLower: baseName.toLowerCase(), ext });
    }
  }

  interface DraftItem {
    id: string;
    baseName: string;
    displayName: string;
    primaryFile: string;
    rawFile: string | null;
    jpegFile: string | null;
    rawExt: string | null;
    jpegExt: string | null;
    kind: 'raw' | 'image' | 'raw+jpeg';
    files: string[];
    xmpFile: string | null;
  }

  const drafts: DraftItem[] = [];

  if (pairingEnabled) {
    // Index image files by lowercase baseName for pairing (prefer JPG/JPEG when pairing with RAW)
    const imgByBase = new Map<string, typeof imgEntries[number]>();
    const unpairedImgs: typeof imgEntries = [];

    for (const img of imgEntries) {
      if ((img.ext === '.jpg' || img.ext === '.jpeg') && !imgByBase.has(img.baseLower)) {
        imgByBase.set(img.baseLower, img);
      } else {
        unpairedImgs.push(img);
      }
    }

    const pairedImgBases = new Set<string>();

    for (const raw of rawEntries) {
      const companion = imgByBase.get(raw.baseLower);
      const xmpFile =
        xmpByLower.get(`${raw.baseLower}.xmp`) ??
        xmpByLower.get(`${raw.name.toLowerCase()}.xmp`) ??
        (companion ? xmpByLower.get(`${companion.name.toLowerCase()}.xmp`) : undefined) ??
        null;

      if (companion) {
        pairedImgBases.add(raw.baseLower);
        drafts.push({
          id: raw.name,
          baseName: raw.baseName,
          displayName: raw.name,
          // Keep RAW as primaryFile (with companion JPEG available for fast preview fallback/toggle)
          primaryFile: raw.name,
          rawFile: raw.name,
          jpegFile: companion.name,
          rawExt: raw.ext.slice(1).toUpperCase(),
          jpegExt: companion.ext.slice(1).toUpperCase(),
          kind: 'raw+jpeg',
          files: [raw.name, companion.name],
          xmpFile,
        });
      } else {
        drafts.push({
          id: raw.name,
          baseName: raw.baseName,
          displayName: raw.name,
          primaryFile: raw.name,
          rawFile: raw.name,
          jpegFile: null,
          rawExt: raw.ext.slice(1).toUpperCase(),
          jpegExt: null,
          kind: 'raw',
          files: [raw.name],
          xmpFile,
        });
      }
    }

    // Remaining unpaired JPEGs + other images
    for (const [baseLower, img] of imgByBase) {
      if (pairedImgBases.has(baseLower)) continue;
      const xmpFile =
        xmpByLower.get(`${img.baseLower}.xmp`) ??
        xmpByLower.get(`${img.name.toLowerCase()}.xmp`) ??
        null;
      drafts.push({
        id: img.name,
        baseName: img.baseName,
        displayName: img.name,
        primaryFile: img.name,
        rawFile: null,
        jpegFile: img.name,
        rawExt: null,
        jpegExt: img.ext.slice(1).toUpperCase(),
        kind: 'image',
        files: [img.name],
        xmpFile,
      });
    }

    for (const img of unpairedImgs) {
      const xmpFile =
        xmpByLower.get(`${img.baseLower}.xmp`) ??
        xmpByLower.get(`${img.name.toLowerCase()}.xmp`) ??
        null;
      drafts.push({
        id: img.name,
        baseName: img.baseName,
        displayName: img.name,
        primaryFile: img.name,
        rawFile: null,
        jpegFile: img.name,
        rawExt: null,
        jpegExt: img.ext.slice(1).toUpperCase(),
        kind: 'image',
        files: [img.name],
        xmpFile,
      });
    }
  } else {
    // Unpaired mode: every RAW and image file is its own item
    for (const raw of rawEntries) {
      const xmpFile =
        xmpByLower.get(`${raw.name.toLowerCase()}.xmp`) ??
        xmpByLower.get(`${raw.baseLower}.xmp`) ??
        null;
      drafts.push({
        id: raw.name,
        baseName: raw.baseName,
        displayName: raw.name,
        primaryFile: raw.name,
        rawFile: raw.name,
        jpegFile: null,
        rawExt: raw.ext.slice(1).toUpperCase(),
        jpegExt: null,
        kind: 'raw',
        files: [raw.name],
        xmpFile,
      });
    }
    for (const img of imgEntries) {
      const xmpFile =
        xmpByLower.get(`${img.name.toLowerCase()}.xmp`) ??
        xmpByLower.get(`${img.baseLower}.xmp`) ??
        null;
      drafts.push({
        id: img.name,
        baseName: img.baseName,
        displayName: img.name,
        primaryFile: img.name,
        rawFile: null,
        jpegFile: img.name,
        rawExt: null,
        jpegExt: img.ext.slice(1).toUpperCase(),
        kind: 'image',
        files: [img.name],
        xmpFile,
      });
    }
  }

  // Parallel stat + existing XMP read (bounded concurrency so 5,000+ photos never exhaust file descriptors)
  const items: PhotoItem[] = new Array(drafts.length);
  await runWithConcurrency(
    drafts.map((draft, i) => ({ draft, i })),
    32,
    async ({ draft, i }) => {
      let sizeBytes = 0;
      let mtimeMs = 0;
      for (const f of draft.files) {
        try {
          const st = await fs.stat(path.join(resolvedFolder, f));
          sizeBytes += st.size;
          if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
        } catch {
          // File may have been removed concurrently
        }
      }

      let metadata: PhotoMetadata = { ...DEFAULT_METADATA };
      if (draft.xmpFile) {
        try {
          metadata = await readXmpFile(path.join(resolvedFolder, draft.xmpFile));
        } catch {
          metadata = { ...DEFAULT_METADATA };
        }
      }

      items[i] = {
        id: draft.id,
        baseName: draft.baseName,
        displayName: draft.displayName,
        primaryFile: draft.primaryFile,
        rawFile: draft.rawFile,
        jpegFile: draft.jpegFile,
        rawExt: draft.rawExt,
        jpegExt: draft.jpegExt,
        kind: draft.kind,
        sizeBytes,
        mtimeMs,
        metadata,
      };
    },
  );

  // Natural filename sort by default (DSC0001 before DSC0002, DSC9 before DSC10)
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  items.sort((a, b) => collator.compare(a.displayName, b.displayName));

  return {
    folder: resolvedFolder,
    pairingEnabled,
    totalFiles: rawEntries.length + imgEntries.length,
    scanMs: Math.round(performance.now() - start),
    items,
  };
}

/**
 * Lists subdirectories and quick-jump locations for the built-in native folder picker.
 */
export async function browseDirectory(dirPath?: string): Promise<BrowseResult> {
  const home = os.homedir();
  const target = dirPath && dirPath.trim() ? path.resolve(dirPath) : process.cwd();

  const entries = await fs.readdir(target, { withFileTypes: true });
  const directories: DirectoryEntry[] = [];
  let photoCountHere = 0;

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      directories.push({
        name: entry.name,
        path: path.join(target, entry.name),
      });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (isPhotoExtension(ext)) photoCountHere++;
    }
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  directories.sort((a, b) => collator.compare(a.name, b.name));

  // Quick paths (Home, Pictures, Desktop, WSL Windows drives, workspace)
  const candidateQuick: { label: string; path: string }[] = [
    { label: 'Workspace', path: process.cwd() },
    { label: 'Home', path: home },
    { label: 'Pictures', path: path.join(home, 'Pictures') },
    { label: 'Desktop', path: path.join(home, 'Desktop') },
    { label: 'Demo Shoot', path: path.join(process.cwd(), 'demo-shoot') },
  ];

  // Detect WSL Windows user Pictures & mounted drives (/mnt/c, /mnt/d, etc.)
  try {
    const mntEntries = await fs.readdir('/mnt', { withFileTypes: true });
    for (const m of mntEntries) {
      if (m.isDirectory() && /^[a-z]$/i.test(m.name)) {
        const drivePath = `/mnt/${m.name}`;
        candidateQuick.push({ label: `Drive ${m.name.toUpperCase()}:`, path: drivePath });
      }
    }
    const winUsers = await fs.readdir('/mnt/c/Users', { withFileTypes: true }).catch(() => []);
    for (const u of winUsers) {
      if (!u.isDirectory() || ['Public', 'Default', 'Default User', 'All Users'].includes(u.name)) continue;
      const winPics = path.join('/mnt/c/Users', u.name, 'Pictures');
      try {
        await fs.access(winPics);
        candidateQuick.push({ label: `Win Pictures (${u.name})`, path: winPics });
      } catch {
        // ignore
      }
    }
  } catch {
    // Non-Linux or no /mnt
  }

  // Filter to existing accessible paths (deduplicated)
  const seen = new Set<string>();
  const quickPaths: { label: string; path: string }[] = [];
  for (const qp of candidateQuick) {
    const resolved = path.resolve(qp.path);
    if (seen.has(resolved)) continue;
    try {
      const st = await fs.stat(resolved);
      if (st.isDirectory()) {
        seen.add(resolved);
        quickPaths.push({ label: qp.label, path: resolved });
      }
    } catch {
      // skip inaccessible
    }
  }

  const parentDir = path.dirname(target);
  return {
    current: target,
    parent: parentDir !== target ? parentDir : null,
    directories,
    photoCountHere,
    quickPaths,
  };
}
