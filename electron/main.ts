import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BatchActionRequest,
  ExifData,
  IngestRequest,
  MetadataPatchRequest,
} from '../shared/types.js';
import { indexPhotoFile, readPhotoImageBytes } from '../server/raw/extractor.js';
import { browseDirectory, scanFolder } from '../server/scanner.js';
import { writeXmpMetadata } from '../server/xmp.js';
import { executeBatchAction, ingestFromSource } from '../server/fileOps.js';
import { generateDemoShoot } from '../server/demoGenerator.js';

// Register `photocull://` before app.ready so fetch(), <img>, and createImageBitmap()
// stream extracted RAW embedded JPEGs directly from disk with zero HTTP socket overhead.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'photocull',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

let mainWindow: BrowserWindow | null = null;
let initialFolder = resolveInitialFolderFromArgs(process.argv);

function resolveInitialFolderFromArgs(argv: string[]): string {
  if (process.env.PHOTOCULL_FOLDER) {
    return path.resolve(process.env.PHOTOCULL_FOLDER);
  }
  // Skip electron executable & app entrypoint / flags
  const candidates = argv.slice(app.isPackaged ? 1 : 2).filter((arg) => !arg.startsWith('-'));
  for (const cand of candidates) {
    if (cand && cand !== '.' && cand !== './') {
      return path.resolve(cand);
    }
  }
  return '';
}

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

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

async function loadWindowBounds(): Promise<WindowBounds> {
  try {
    const raw = await fs.readFile(getWindowStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<WindowBounds>;
    return {
      width: Math.max(900, parsed.width ?? 1440),
      height: Math.max(600, parsed.height ?? 900),
      x: typeof parsed.x === 'number' ? parsed.x : undefined,
      y: typeof parsed.y === 'number' ? parsed.y : undefined,
      isMaximized: Boolean(parsed.isMaximized),
    };
  } catch {
    return { width: 1440, height: 900 };
  }
}

async function saveWindowBounds(win: BrowserWindow): Promise<void> {
  try {
    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    const state: WindowBounds = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized,
    };
    await fs.writeFile(getWindowStatePath(), JSON.stringify(state), 'utf8');
  } catch {
    // ignore persistence errors
  }
}

function sendMenuAction(action: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('photocull:menu-action', { action, payload });
  }
}

function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Photo Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuAction('open-folder'),
        },
        {
          label: 'Reveal Active Photo in File Manager',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => sendMenuAction('reveal-current'),
        },
        { type: 'separator' },
        {
          label: 'Copy / Move Keepers…',
          accelerator: 'CmdOrCtrl+E',
          click: () => sendMenuAction('batch-export'),
        },
        {
          label: 'Move Photos to Trash…',
          accelerator: 'CmdOrCtrl+Backspace',
          click: () => sendMenuAction('batch-trash'),
        },
        {
          label: 'Ingest from SD Card…',
          accelerator: 'CmdOrCtrl+I',
          click: () => sendMenuAction('batch-ingest'),
        },
        { type: 'separator' },
        {
          label: 'Create Demo RAW Shoot',
          click: () => sendMenuAction('generate-demo'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Contact Sheet (Grid)', click: () => sendMenuAction('view-grid') },
        { label: 'Single-Image Loupe', click: () => sendMenuAction('view-loupe') },
        { label: '2-Up Side-by-Side Compare', click: () => sendMenuAction('view-compare') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'F1',
          click: () => sendMenuAction('show-shortcuts'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerProtocol(): void {
  protocol.handle('photocull', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'image') {
        return new Response('Not Found', { status: 404 });
      }

      const dir = url.searchParams.get('dir');
      const file = url.searchParams.get('file');
      const variant = url.searchParams.get('variant') === 'thumb' ? 'thumb' : 'preview';
      const fallbackFile = url.searchParams.get('fallback') || '';

      if (!dir || !file) {
        return new Response('Missing dir or file', { status: 400 });
      }

      const primaryPath = safeChildPath(dir, file);
      let extracted = await readPhotoImageBytes(primaryPath, variant);
      if (!extracted && fallbackFile) {
        const fallbackPath = safeChildPath(dir, fallbackFile);
        extracted = await readPhotoImageBytes(fallbackPath, variant);
      }

      if (!extracted) {
        return new Response('No embedded preview found', { status: 404 });
      }

      // Copy into an ArrayBuffer-backed Uint8Array for standard Web Response
      const body = new Uint8Array(extracted.bytes);

      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': extracted.mimeType,
          'Content-Length': String(extracted.bytes.length),
          'Cache-Control': 'private, max-age=3600',
          'X-Exif-Orientation': String(extracted.orientation),
          'X-Image-Width': String(extracted.width),
          'X-Image-Height': String(extracted.height),
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(msg, { status: 500 });
    }
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('photocull:get-initial-info', async () => ({
    ok: true,
    version: app.getVersion(),
    initialFolder,
    cwd: process.cwd(),
    platform: process.platform,
    isElectron: true,
  }));

  ipcMain.handle(
    'photocull:pick-folder',
    async (_evt, opts?: { title?: string; defaultPath?: string }) => {
      const win = mainWindow ?? BrowserWindow.getFocusedWindow();
      const dialogOpts: Electron.OpenDialogOptions = {
        title: opts?.title || 'Open Photo Folder',
        defaultPath: opts?.defaultPath || undefined,
        properties: ['openDirectory', 'createDirectory'],
      };
      const res = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts);
      if (res.canceled || res.filePaths.length === 0) return null;
      return res.filePaths[0];
    },
  );

  ipcMain.handle('photocull:browse', async (_evt, dir?: string) => {
    return browseDirectory(dir);
  });

  ipcMain.handle('photocull:scan-folder', async (_evt, dir: string, pairing: boolean) => {
    return scanFolder(dir, pairing);
  });

  ipcMain.handle('photocull:exif', async (_evt, dir: string, file: string) => {
    const fullPath = safeChildPath(dir, file);
    const idx = await indexPhotoFile(fullPath);
    return {
      file,
      exif: idx.exif,
      previewSource: idx.preview?.source ?? null,
      thumbSource: idx.thumbnail?.source ?? null,
    };
  });

  ipcMain.handle('photocull:exif-batch', async (_evt, dir: string, files: string[]) => {
    const results: Record<string, ExifData> = {};
    const limited = files.slice(0, 64);
    await Promise.all(
      limited.map(async (file) => {
        try {
          const fullPath = safeChildPath(dir, file);
          const idx = await indexPhotoFile(fullPath);
          results[file] = idx.exif;
        } catch {
          // ignore unreadable files
        }
      }),
    );
    return { exif: results };
  });

  ipcMain.handle('photocull:patch-metadata', async (_evt, req: MetadataPatchRequest) => {
    const resolvedFolder = path.resolve(req.folder);
    const primaryFile = path.basename(req.itemId);
    const ext = path.extname(primaryFile);
    const baseName = primaryFile.slice(0, primaryFile.length - ext.length);

    const metadata = await writeXmpMetadata(
      resolvedFolder,
      baseName,
      primaryFile,
      Math.max(0, Math.min(5, req.rating ?? 0)),
    );
    return { itemId: req.itemId, metadata };
  });

  ipcMain.handle('photocull:batch-action', async (_evt, req: BatchActionRequest) => {
    return executeBatchAction(req, {
      nativeTrashFile: (filePath) => shell.trashItem(filePath),
    });
  });

  ipcMain.handle('photocull:ingest', async (_evt, req: IngestRequest) => {
    return ingestFromSource(req);
  });

  ipcMain.handle('photocull:generate-demo', async (_evt, count?: number) => {
    const baseDir = app.isPackaged ? app.getPath('pictures') : process.cwd();
    const target = path.join(baseDir, 'PhotoCull-Demo-Shoot');
    return generateDemoShoot(target, Math.max(4, Math.min(120, count ?? 24)));
  });

  ipcMain.handle('photocull:reveal-in-folder', async (_evt, dir: string, file: string) => {
    const fullPath = safeChildPath(dir, file);
    shell.showItemInFolder(fullPath);
    return true;
  });

  ipcMain.handle('photocull:resolve-dropped-folder', async (_evt, droppedPath: string) => {
    const resolved = path.resolve(droppedPath);
    const st = await fs.stat(resolved);
    return st.isDirectory() ? resolved : path.dirname(resolved);
  });
}

async function createMainWindow(): Promise<void> {
  const bounds = await loadWindowBounds();

  const appRoot = app.getAppPath();
  const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const iconPath = path.join(appRoot, 'build', iconFile);

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 880,
    minHeight: 560,
    show: false,
    backgroundColor: '#0d0d0f',
    darkTheme: true,
    icon: iconPath,
    title: 'PhotoCull — Ultra-Fast RAW Photo Culling',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(appRoot, 'dist-electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow = win;

  win.webContents.on('preload-error', (_evt, preloadPath, err) => {
    console.error('[PhotoCull] Preload error:', preloadPath, err);
  });

  win.once('ready-to-show', () => {
    if (bounds.isMaximized) win.maximize();
    win.show();
  });

  win.on('close', () => {
    void saveWindowBounds(win);
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    const indexHtml = path.join(appRoot, 'dist', 'index.html');
    await win.loadFile(indexHtml);
  }
}

// Single-instance lock so opening a folder from OS focuses existing window
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    const nextFolder = resolveInitialFolderFromArgs(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (nextFolder) {
        sendMenuAction('open-specific-folder', nextFolder);
      }
    }
  });

  app.on('open-file', (evt, filePath) => {
    evt.preventDefault();
    if (mainWindow) {
      sendMenuAction('open-specific-folder', filePath);
    } else {
      initialFolder = filePath;
    }
  });

  app.whenReady().then(async () => {
    registerProtocol();
    registerIpcHandlers();
    buildApplicationMenu();
    await createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
