import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { generateDemoShoot } from '../server/demoGenerator.js';
import { scanFolder } from '../server/scanner.js';
import { executeBatchAction, ingestFromSource } from '../server/fileOps.js';
import { createAppServer } from '../server/index.js';

let rootTmp = '';
let shootDir = '';
let server: http.Server | null = null;
let baseUrl = '';

beforeAll(async () => {
  rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-workflow-'));
  shootDir = path.join(rootTmp, 'shoot');
  await generateDemoShoot(shootDir, 8);

  server = createAppServer();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (addr && typeof addr === 'object') {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (rootTmp) await fs.rm(rootTmp, { recursive: true, force: true });
});

describe('RAW+JPEG Pairing, Batch File Ops & HTTP API End-to-End', () => {
  test('pairs RAW+JPEG matching basenames when enabled and separates when disabled', async () => {
    const paired = await scanFolder(shootDir, true);
    expect(paired.items.length).toBe(8);
    const pairedItems = paired.items.filter((i) => i.kind === 'raw+jpeg');
    expect(pairedItems.length).toBe(4);

    const unpaired = await scanFolder(shootDir, false);
    expect(unpaired.items.length).toBe(12);
  });

  test('copies paired keepers with RAW + JPG + XMP kept in sync, and safely trashes unrated items', async () => {
    const scan = await scanFolder(shootDir, true);
    const keeper = scan.items.find((i) => i.kind === 'raw+jpeg' && i.metadata.rating >= 4)!;
    expect(keeper).toBeDefined();

    const exportDir = path.join(rootTmp, 'Selects');
    const copyRes = await executeBatchAction({
      folder: shootDir,
      itemIds: [keeper.id],
      action: 'copy',
      targetFolder: exportDir,
      pairingEnabled: true,
    });

    expect(copyRes.processedItems).toBe(1);
    expect(copyRes.processedFiles).toBe(3); // RAW + JPG + XMP!

    const exportedFiles = await fs.readdir(exportDir);
    expect(exportedFiles).toContain(keeper.rawFile!);
    expect(exportedFiles).toContain(keeper.jpegFile!);
    expect(exportedFiles).toContain(`${keeper.baseName}.xmp`);

    const unrated = scan.items.filter((i) => i.metadata.rating === 0);
    expect(unrated.length).toBeGreaterThan(0);

    const trashRes = await executeBatchAction({
      folder: shootDir,
      itemIds: [unrated[0].id],
      action: 'trash',
      pairingEnabled: true,
    });
    expect(trashRes.processedItems).toBe(1);

    const afterTrash = await scanFolder(shootDir, true);
    expect(afterTrash.items.find((i) => i.id === unrated[0].id)).toBeUndefined();
  });

  test('ingests files from a nested DCIM source into templated shoot folder', async () => {
    const sdCard = path.join(rootTmp, 'SD_CARD', 'DCIM', '100MSDCF');
    await fs.mkdir(sdCard, { recursive: true });
    await fs.writeFile(path.join(sdCard, 'TEST001.JPG'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const ingestRoot = path.join(rootTmp, 'Ingested');
    const res = await ingestFromSource({
      sourceFolder: path.join(rootTmp, 'SD_CARD'),
      targetRoot: ingestRoot,
      template: '{YYYY}-{MM}-{DD}_{name}',
      shootName: 'Alpine Sprint',
      includeSidecars: true,
    });

    expect(res.copiedFiles).toBe(1);
    expect(path.basename(res.destinationFolder)).toMatch(/^\d{4}-\d{2}-\d{2}_Alpine_Sprint$/);
  });

  test('HTTP API serves folder scan, embedded preview JPEG, EXIF, and atomic XMP rating writes', async () => {
    const folderRes = await fetch(`${baseUrl}/api/folder?dir=${encodeURIComponent(shootDir)}&pairing=true`);
    expect(folderRes.status).toBe(200);
    const folderJson = (await folderRes.json()) as { items: { id: string; primaryFile: string }[] };
    expect(folderJson.items.length).toBeGreaterThan(0);

    const first = folderJson.items[0];
    const imgRes = await fetch(
      `${baseUrl}/api/image?dir=${encodeURIComponent(shootDir)}&file=${encodeURIComponent(first.primaryFile)}&variant=preview`,
    );
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get('content-type')).toBe('image/jpeg');
    const bytes = new Uint8Array(await imgRes.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes[2]).toBe(0xff);

    const patchRes = await fetch(`${baseUrl}/api/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: shootDir,
        itemId: first.id,
        rating: 5,
        pairingEnabled: true,
      }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { metadata: { rating: number; hasXmp: boolean } };
    expect(patched.metadata).toEqual({ rating: 5, hasXmp: true });
  });
});
