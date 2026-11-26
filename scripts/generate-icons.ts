/**
 * Generates platform desktop & web icons from `build/icon.svg`:
 *   - build/icon.png     (512x512 PNG for Linux AppImage/deb & Electron BrowserWindow)
 *   - build/icon.ico     (Multi-size Windows ICO: 16, 24, 32, 48, 64, 128, 256)
 *   - build/icon.icns    (Multi-size macOS ICNS: 16..1024 PNG chunks)
 *   - public/icon.svg    (Vector favicon for web & Vite builds)
 *
 * Uses Electron's bundled Chromium renderer (via xvfb-run on headless Linux) so no external
 * image dependencies (ImageMagick, Inkscape, sharp, Pillow) are required.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const svgPath = path.join(root, 'build', 'icon.svg');
const buildDir = path.join(root, 'build');
const publicDir = path.join(root, 'public');

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024] as const;

function hasCommand(cmd: string): boolean {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    stdio: 'ignore',
  });
  return res.status === 0;
}

function buildIco(entries: Array<{ size: number; png: Buffer }>): Buffer {
  const headerSize = 6;
  const dirEntrySize = 16;
  const dataStart = headerSize + entries.length * dirEntrySize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = ICO
  header.writeUInt16LE(entries.length, 4);

  const dirEntries: Buffer[] = [];
  let offset = dataStart;

  for (const { size, png } of entries) {
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height (0 = 256)
    entry.writeUInt8(0, 2); // color palette count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // image data size
    entry.writeUInt32LE(offset, 12); // image data offset
    dirEntries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...entries.map((e) => e.png)]);
}

function buildIcns(pngBySize: Map<number, Buffer>): Buffer {
  // Standard macOS PNG-encoded ICNS OSType chunks
  const mapping: Array<[string, number]> = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512],
  ];

  const chunks: Buffer[] = [];
  for (const [type, size] of mapping) {
    const png = pngBySize.get(size);
    if (!png) continue;
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(8 + png.length, 4);
    chunks.push(header, png);
  }

  const totalLength = 8 + chunks.reduce((sum, b) => sum + b.length, 0);
  const fileHeader = Buffer.alloc(8);
  fileHeader.write('icns', 0, 4, 'ascii');
  fileHeader.writeUInt32BE(totalLength, 4);

  return Buffer.concat([fileHeader, ...chunks]);
}

function rasterizeSvgWithElectron(svgFile: string, outDir: string, sizes: readonly number[]): void {
  const runnerScript = path.join(outDir, 'render-icons.cjs');
  const scriptSource = `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const svgContent = fs.readFileSync(${JSON.stringify(svgFile)}, 'utf8');
const sizes = ${JSON.stringify(sizes)};
const outDir = ${JSON.stringify(outDir)};

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: false,
      nodeIntegration: false,
    },
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body style="margin:0;background:transparent;"></body></html>'));

  const results = await win.webContents.executeJavaScript(\`
    (async () => {
      const svg = \${JSON.stringify(svgContent)};
      const sizes = \${JSON.stringify(sizes)};
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.decoding = 'sync';
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });

      const out = {};
      for (const size of sizes) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        out[size] = canvas.toDataURL('image/png').split(',')[1];
      }
      URL.revokeObjectURL(url);
      return out;
    })()
  \`);

  for (const [size, b64] of Object.entries(results)) {
    fs.writeFileSync(path.join(outDir, 'icon-' + size + '.png'), Buffer.from(b64, 'base64'));
  }

  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
`;

  writeFileSync(runnerScript, scriptSource, 'utf8');

  const electronBin = path.join(
    root,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron.cmd' : 'electron',
  );

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const needsXvfb = process.platform === 'linux' && !env.DISPLAY && hasCommand('xvfb-run');
  const cmd = needsXvfb ? 'xvfb-run' : electronBin;
  const args = needsXvfb
    ? ['-a', electronBin, '--no-sandbox', runnerScript]
    : ['--no-sandbox', runnerScript];

  const res = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (res.status !== 0) {
    throw new Error(`Electron icon rasterization failed with exit code ${res.status}`);
  }
}

mkdirSync(buildDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

const tmp = mkdtempSync(path.join(tmpdir(), 'photocull-icons-'));
try {
  rasterizeSvgWithElectron(svgPath, tmp, SIZES);

  const pngBySize = new Map<number, Buffer>();
  for (const size of SIZES) {
    pngBySize.set(size, readFileSync(path.join(tmp, `icon-${size}.png`)));
  }

  // 1. Linux & Electron BrowserWindow PNG (512x512)
  const png512 = pngBySize.get(512)!;
  writeFileSync(path.join(buildDir, 'icon.png'), png512);

  // 2. Windows multi-size ICO (16..256)
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuf = buildIco(icoSizes.map((size) => ({ size, png: pngBySize.get(size)! })));
  writeFileSync(path.join(buildDir, 'icon.ico'), icoBuf);

  // 3. macOS multi-size ICNS (16..1024)
  const icnsBuf = buildIcns(pngBySize);
  writeFileSync(path.join(buildDir, 'icon.icns'), icnsBuf);

  // 4. Web favicon (vector SVG)
  copyFileSync(svgPath, path.join(publicDir, 'icon.svg'));

  console.log('Generated app icons:');
  console.log(`  build/icon.png  (${png512.length} bytes, 512x512)`);
  console.log(`  build/icon.ico  (${icoBuf.length} bytes, sizes: ${icoSizes.join(', ')})`);
  console.log(`  build/icon.icns (${icnsBuf.length} bytes, 16..1024)`);
  console.log('  public/icon.svg (vector favicon)');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
