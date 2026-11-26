import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type BatchActionRequest,
  type BatchActionResult,
  IMAGE_EXTENSIONS,
  type IngestRequest,
  type IngestResult,
  RAW_EXTENSIONS,
} from '../shared/types.js';
import { scanFolder } from './scanner.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveTargetFilePath(
  targetDir: string,
  fileName: string,
  strategy: 'skip' | 'rename' | 'overwrite',
): Promise<string | null> {
  const initial = path.join(targetDir, fileName);
  if (!(await fileExists(initial))) return initial;
  if (strategy === 'overwrite') return initial;
  if (strategy === 'skip') return null;

  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    const candidate = path.join(targetDir, `${base}_${i}${ext}`);
    if (!(await fileExists(candidate))) return candidate;
  }
  return null;
}

/**
 * Moves a file safely across filesystems (uses rename when same device, falls back to copy+unlink on EXDEV).
 */
async function moveFileSafe(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EXDEV' || code === 'EPERM') {
      await fs.copyFile(src, dest);
      await fs.unlink(src);
    } else {
      throw err;
    }
  }
}

/**
 * Safely moves a file to the OS Trash (FreeDesktop spec on Linux, ~/.Trash on macOS),
 * or falls back to a local `.PhotoCull_Trash` folder inside the source directory when moving across mounts
 * (e.g., WSL /mnt/c or external SD card / SSD where FreeDesktop trash is on a different device).
 */
async function moveToSafeTrash(srcPath: string, sourceFolder: string): Promise<string> {
  const fileName = path.basename(srcPath);
  const platform = process.platform;

  // Attempt FreeDesktop Trash on Linux if on the same device as $HOME
  if (platform === 'linux') {
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    const trashFilesDir = path.join(xdgData, 'Trash', 'files');
    const trashInfoDir = path.join(xdgData, 'Trash', 'info');
    try {
      await fs.mkdir(trashFilesDir, { recursive: true });
      await fs.mkdir(trashInfoDir, { recursive: true });
      const [srcStat, trashStat] = await Promise.all([fs.stat(srcPath), fs.stat(trashFilesDir)]);
      if (srcStat.dev === trashStat.dev) {
        const destFile = (await resolveTargetFilePath(trashFilesDir, fileName, 'rename'))!;
        const trashName = path.basename(destFile);
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const delDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        const infoContent = `[Trash Info]\nPath=${encodeURI(srcPath)}\nDeletionDate=${delDate}\n`;
        await fs.writeFile(path.join(trashInfoDir, `${trashName}.trashinfo`), infoContent, 'utf8');
        await fs.rename(srcPath, destFile);
        return trashFilesDir;
      }
    } catch {
      // Fallback to local .PhotoCull_Trash below
    }
  } else if (platform === 'darwin') {
    const macTrash = path.join(os.homedir(), '.Trash');
    try {
      const [srcStat, trashStat] = await Promise.all([fs.stat(srcPath), fs.stat(macTrash)]);
      if (srcStat.dev === trashStat.dev) {
        const destFile = (await resolveTargetFilePath(macTrash, fileName, 'rename'))!;
        await fs.rename(srcPath, destFile);
        return macTrash;
      }
    } catch {
      // Fallback below
    }
  }

  // Same-volume local trash fallback (instant rename, zero accidental permanent deletion!)
  const localTrash = path.join(sourceFolder, '.PhotoCull_Trash');
  await fs.mkdir(localTrash, { recursive: true });
  const destFile = (await resolveTargetFilePath(localTrash, fileName, 'rename'))!;
  await moveFileSafe(srcPath, destFile);
  return localTrash;
}

export interface BatchExecOptions {
  /** Optional native OS trash hook (e.g. Electron's `shell.trashItem`). Falls back to local safe trash on error. */
  nativeTrashFile?: (filePath: string) => Promise<void>;
}

/**
 * Executes batch Copy, Move, or Safe Trash on selected/filtered PhotoItems.
 * Always keeps RAW + paired JPEG + `.xmp` sidecar files in sync!
 */
export async function executeBatchAction(
  req: BatchActionRequest,
  options: BatchExecOptions = {},
): Promise<BatchActionResult> {
  const folder = path.resolve(req.folder);
  const scan = await scanFolder(folder, req.pairingEnabled);
  const itemById = new Map(scan.items.map((it) => [it.id, it]));

  const strategy = req.conflictStrategy ?? 'rename';
  let targetFolder: string | null = null;

  if (req.action === 'copy' || req.action === 'move') {
    if (!req.targetFolder || !req.targetFolder.trim()) {
      throw new Error('Target folder is required for copy/move actions.');
    }
    targetFolder = path.resolve(req.targetFolder);
    await fs.mkdir(targetFolder, { recursive: true });
  }

  let processedItems = 0;
  let processedFiles = 0;
  let skippedItems = 0;
  let trashDir: string | undefined;
  const errors: { itemId: string; message: string }[] = [];

  for (const itemId of req.itemIds) {
    const item = itemById.get(itemId);
    if (!item) {
      skippedItems++;
      continue;
    }

    // Collect all linked files: RAW + paired JPEG + any existing XMP sidecar(s)
    const filesToProcess = new Set<string>();
    if (item.rawFile) filesToProcess.add(item.rawFile);
    if (item.jpegFile) filesToProcess.add(item.jpegFile);

    const possibleXmps = [
      `${item.baseName}.xmp`,
      `${item.primaryFile}.xmp`,
      ...(item.rawFile ? [`${item.rawFile}.xmp`] : []),
      ...(item.jpegFile ? [`${item.jpegFile}.xmp`] : []),
    ];
    for (const xmpName of possibleXmps) {
      if (await fileExists(path.join(folder, xmpName))) {
        filesToProcess.add(xmpName);
      }
    }

    try {
      let anyMoved = false;
      for (const fileName of filesToProcess) {
        const src = path.join(folder, fileName);
        if (!(await fileExists(src))) continue;

        if (req.action === 'trash') {
          if (options.nativeTrashFile) {
            try {
              await options.nativeTrashFile(src);
              trashDir = 'System Trash';
            } catch {
              trashDir = await moveToSafeTrash(src, folder);
            }
          } else {
            trashDir = await moveToSafeTrash(src, folder);
          }
          processedFiles++;
          anyMoved = true;
        } else if (req.action === 'copy' && targetFolder) {
          const dest = await resolveTargetFilePath(targetFolder, fileName, strategy);
          if (dest) {
            await fs.copyFile(src, dest);
            processedFiles++;
            anyMoved = true;
          }
        } else if (req.action === 'move' && targetFolder) {
          const dest = await resolveTargetFilePath(targetFolder, fileName, strategy);
          if (dest) {
            await moveFileSafe(src, dest);
            processedFiles++;
            anyMoved = true;
          }
        }
      }
      if (anyMoved) processedItems++;
      else skippedItems++;
    } catch (err: unknown) {
      errors.push({
        itemId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    processedItems,
    processedFiles,
    skippedItems,
    errors,
    trashDir,
  };
}

/**
 * Basic SD Card / Folder Ingest with date/name folder template (e.g. `{YYYY}-{MM}-{DD}_{name}`).
 * Recursively collects photos (handles `DCIM/100MSDCF`, `DCIM/100CANON`, etc.) and copies them safely.
 */
export async function ingestFromSource(req: IngestRequest): Promise<IngestResult> {
  const source = path.resolve(req.sourceFolder);
  const targetRoot = path.resolve(req.targetRoot);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const safeName = (req.shootName || 'Shoot').trim().replace(/[^\w\- ]+/g, '_').replace(/\s+/g, '_');

  const folderName = (req.template || '{YYYY}-{MM}-{DD}_{name}')
    .replace(/\{YYYY\}/g, String(now.getFullYear()))
    .replace(/\{MM\}/g, pad(now.getMonth() + 1))
    .replace(/\{DD\}/g, pad(now.getDate()))
    .replace(/\{name\}/g, safeName);

  const destinationFolder = path.join(targetRoot, folderName);
  await fs.mkdir(destinationFolder, { recursive: true });

  const filesToCopy: string[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > 4) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (RAW_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext) || (req.includeSidecars && ext === '.xmp')) {
          filesToCopy.push(full);
        }
      }
    }
  }

  await walk(source, 0);

  let copiedFiles = 0;
  let skippedFiles = 0;
  let totalBytes = 0;

  for (const srcFile of filesToCopy) {
    const destPath = path.join(destinationFolder, path.basename(srcFile));
    if (await fileExists(destPath)) {
      skippedFiles++;
      continue;
    }
    const st = await fs.stat(srcFile);
    await fs.copyFile(srcFile, destPath);
    copiedFiles++;
    totalBytes += st.size;
  }

  return {
    destinationFolder,
    copiedFiles,
    skippedFiles,
    totalBytes,
  };
}
