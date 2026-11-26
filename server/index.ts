import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BatchActionRequest,
  IngestRequest,
  MetadataPatchRequest,
} from '../shared/types.js';
import { indexPhotoFile, readPhotoImageBytes } from './raw/extractor.js';
import { browseDirectory, scanFolder } from './scanner.js';
import { writeXmpMetadata } from './xmp.js';
import { executeBatchAction, ingestFromSource } from './fileOps.js';
import { generateDemoShoot } from './demoGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PHOTOCULL_PORT || process.env.PORT || 4174);
const HOST = process.env.PHOTOCULL_HOST || '127.0.0.1';
const INITIAL_FOLDER = process.env.PHOTOCULL_FOLDER || process.argv[2] || '';

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > 10 * 1024 * 1024) {
      throw new Error('Request payload too large');
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text) as T;
}

/**
 * Ensures `file` is a direct child inside `dir` (prevents path traversal).
 */
function safeChildPath(dir: string, file: string): string {
  const resolvedDir = path.resolve(dir);
  const baseName = path.basename(file);
  if (!baseName || baseName === '.' || baseName === '..' || baseName !== file) {
    throw new Error('Invalid filename');
  }
  const full = path.resolve(resolvedDir, baseName);
  if (!full.startsWith(resolvedDir + path.sep) && full !== resolvedDir) {
    throw new Error('Path traversal rejected');
  }
  return full;
}

async function resolveDistDir(): Promise<string | null> {
  const candidates = [
    path.resolve(__dirname, '../dist'),
    path.resolve(process.cwd(), 'dist'),
  ];
  for (const c of candidates) {
    try {
      const st = await fs.stat(path.join(c, 'index.html'));
      if (st.isFile()) return c;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Handles all `/api/*` HTTP requests. Returns `true` if handled, `false` for non-API paths.
 * Used both by the standalone HTTP server and Vite's dev server middleware (so browser previews work with zero proxy errors).
 */
export async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/')) {
    return false;
  }

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        version: '0.1.0',
        initialFolder: INITIAL_FOLDER ? path.resolve(INITIAL_FOLDER) : '',
        cwd: process.cwd(),
      });
      return true;
    }

    if (pathname === '/api/browse' && req.method === 'GET') {
      const dir = url.searchParams.get('dir') || undefined;
      const result = await browseDirectory(dir);
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/folder' && req.method === 'GET') {
      const dir = url.searchParams.get('dir');
      if (!dir) {
        sendJson(res, 400, { error: 'Missing dir parameter' });
        return true;
      }
      const pairing = url.searchParams.get('pairing') !== 'false';
      const result = await scanFolder(dir, pairing);
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/image' && req.method === 'GET') {
      const dir = url.searchParams.get('dir');
      const file = url.searchParams.get('file');
      const variant = url.searchParams.get('variant') === 'thumb' ? 'thumb' : 'preview';
      const fallbackFile = url.searchParams.get('fallback') || '';

      if (!dir || !file) {
        sendJson(res, 400, { error: 'Missing dir or file parameter' });
        return true;
      }

      const primaryPath = safeChildPath(dir, file);
      const stat = await fs.stat(primaryPath);
      const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}-${variant}"`;

      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, max-age=3600' });
        res.end();
        return true;
      }

      let extracted = await readPhotoImageBytes(primaryPath, variant);
      // If RAW had no embedded preview but a paired JPEG exists, fall back seamlessly
      if (!extracted && fallbackFile) {
        const fallbackPath = safeChildPath(dir, fallbackFile);
        extracted = await readPhotoImageBytes(fallbackPath, variant);
      }

      if (!extracted) {
        sendJson(res, 404, { error: 'No embedded preview found in RAW file' });
        return true;
      }

      res.writeHead(200, {
        'Content-Type': extracted.mimeType,
        'Content-Length': extracted.bytes.length,
        ETag: etag,
        'Cache-Control': 'private, max-age=3600',
        'X-Exif-Orientation': String(extracted.orientation),
        'X-Image-Width': String(extracted.width),
        'X-Image-Height': String(extracted.height),
      });
      res.end(extracted.bytes);
      return true;
    }

    if (pathname === '/api/exif' && req.method === 'GET') {
      const dir = url.searchParams.get('dir');
      const file = url.searchParams.get('file');
      if (!dir || !file) {
        sendJson(res, 400, { error: 'Missing dir or file parameter' });
        return true;
      }
      const fullPath = safeChildPath(dir, file);
      const index = await indexPhotoFile(fullPath);
      sendJson(res, 200, {
        file,
        exif: index.exif,
        previewSource: index.preview?.source ?? null,
        thumbSource: index.thumbnail?.source ?? null,
      });
      return true;
    }

    if (pathname === '/api/exif/batch' && req.method === 'POST') {
      const body = await readJsonBody<{ dir: string; files: string[] }>(req);
      if (!body.dir || !Array.isArray(body.files)) {
        sendJson(res, 400, { error: 'Invalid payload' });
        return true;
      }
      const results: Record<string, unknown> = {};
      const limited = body.files.slice(0, 64);
      await Promise.all(
        limited.map(async (file) => {
          try {
            const fullPath = safeChildPath(body.dir, file);
            const idx = await indexPhotoFile(fullPath);
            results[file] = idx.exif;
          } catch {
            // skip unreadable file
          }
        }),
      );
      sendJson(res, 200, { exif: results });
      return true;
    }

    if (pathname === '/api/metadata' && req.method === 'POST') {
      const body = await readJsonBody<MetadataPatchRequest>(req);
      if (!body.folder || !body.itemId) {
        sendJson(res, 400, { error: 'Missing folder or itemId' });
        return true;
      }
      const resolvedFolder = path.resolve(body.folder);
      const primaryFile = path.basename(body.itemId);
      const ext = path.extname(primaryFile);
      const baseName = primaryFile.slice(0, primaryFile.length - ext.length);

      const nextMeta = await writeXmpMetadata(
        resolvedFolder,
        baseName,
        primaryFile,
        Math.max(0, Math.min(5, body.rating ?? 0)),
      );
      sendJson(res, 200, { itemId: body.itemId, metadata: nextMeta });
      return true;
    }

    if (pathname === '/api/batch' && req.method === 'POST') {
      const body = await readJsonBody<BatchActionRequest>(req);
      const result = await executeBatchAction(body);
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/ingest' && req.method === 'POST') {
      const body = await readJsonBody<IngestRequest>(req);
      const result = await ingestFromSource(body);
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/demo' && req.method === 'POST') {
      const body = await readJsonBody<{ targetDir?: string; count?: number }>(req).catch(
        () => ({} as { targetDir?: string; count?: number }),
      );
      const target = body.targetDir || path.join(process.cwd(), 'demo-shoot');
      const count = Math.max(4, Math.min(120, body.count ?? 24));
      const resDemo = await generateDemoShoot(target, count);
      sendJson(res, 200, resDemo);
      return true;
    }

    sendJson(res, 404, { error: `Not found: ${pathname}` });
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as NodeJS.ErrnoException)?.code;
    const status = code === 'ENOENT' ? 404 : code === 'EACCES' ? 403 : 500;
    sendJson(res, status, { error: message });
    return true;
  }
}

export function createAppServer(): http.Server {
  let distDirPromise: Promise<string | null> | null = null;

  return http.createServer(async (req, res) => {
    try {
      if (await handleApiRequest(req, res)) {
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      // Production static frontend serving
      if (!distDirPromise) distDirPromise = resolveDistDir();
      const distDir = await distDirPromise;
      if (distDir && req.method === 'GET') {
        const reqRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const candidate = path.resolve(distDir, reqRel);
        if (candidate.startsWith(distDir)) {
          try {
            const st = await fs.stat(candidate);
            if (st.isFile()) {
              const data = await fs.readFile(candidate);
              const ext = path.extname(candidate).toLowerCase();
              res.writeHead(200, {
                'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
                'Content-Length': data.length,
                'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
              });
              res.end(data);
              return;
            }
          } catch {
            // Fall through to index.html for SPA
          }
        }
        const html = await fs.readFile(path.join(distDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
        res.end(html);
        return;
      }

      sendJson(res, 404, { error: `Not found: ${pathname}` });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException)?.code;
      const status = code === 'ENOENT' ? 404 : code === 'EACCES' ? 403 : 500;
      sendJson(res, status, { error: message });
    }
  });
}

// Start server when executed directly
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  const server = createAppServer();
  server.listen(PORT, HOST, () => {
    console.log(`\x1b[33m⚡ PhotoCull Engine\x1b[0m listening on http://${HOST}:${PORT}`);
    if (INITIAL_FOLDER) {
      console.log(`   Initial folder: ${path.resolve(INITIAL_FOLDER)}`);
    }
  });
}
