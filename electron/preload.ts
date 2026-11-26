import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  BatchActionRequest,
  BatchActionResult,
  BrowseResult,
  ExifData,
  FolderScanResult,
  IngestRequest,
  IngestResult,
  MetadataPatchRequest,
  PhotoMetadata,
} from '../shared/types.js';

export interface MenuActionEvent {
  action: string;
  payload?: unknown;
}

export interface ElectronAPI {
  isElectron: true;
  platform: NodeJS.Platform;
  getInitialInfo(): Promise<{
    ok: boolean;
    version: string;
    initialFolder: string;
    cwd: string;
    platform: string;
    isElectron: boolean;
  }>;
  pickFolder(opts?: { title?: string; defaultPath?: string }): Promise<string | null>;
  browse(dir?: string): Promise<BrowseResult>;
  scanFolder(dir: string, pairing: boolean): Promise<FolderScanResult>;
  fetchExif(dir: string, file: string): Promise<{ file: string; exif: ExifData }>;
  fetchExifBatch(dir: string, files: string[]): Promise<{ exif: Record<string, ExifData> }>;
  patchMetadata(req: MetadataPatchRequest): Promise<{ itemId: string; metadata: PhotoMetadata }>;
  runBatchAction(req: BatchActionRequest): Promise<BatchActionResult>;
  runIngest(req: IngestRequest): Promise<IngestResult>;
  generateDemo(count?: number): Promise<{ folder: string; created: number }>;
  revealInFolder(dir: string, file: string): Promise<boolean>;
  resolveDroppedFolder(droppedPath: string): Promise<string>;
  getPathForFile(file: File): string;
  onMenuAction(handler: (evt: MenuActionEvent) => void): () => void;
}

const api: ElectronAPI = {
  isElectron: true,
  platform: process.platform,
  getInitialInfo: () => ipcRenderer.invoke('photocull:get-initial-info'),
  pickFolder: (opts) => ipcRenderer.invoke('photocull:pick-folder', opts),
  browse: (dir) => ipcRenderer.invoke('photocull:browse', dir),
  scanFolder: (dir, pairing) => ipcRenderer.invoke('photocull:scan-folder', dir, pairing),
  fetchExif: (dir, file) => ipcRenderer.invoke('photocull:exif', dir, file),
  fetchExifBatch: (dir, files) => ipcRenderer.invoke('photocull:exif-batch', dir, files),
  patchMetadata: (req) => ipcRenderer.invoke('photocull:patch-metadata', req),
  runBatchAction: (req) => ipcRenderer.invoke('photocull:batch-action', req),
  runIngest: (req) => ipcRenderer.invoke('photocull:ingest', req),
  generateDemo: (count) => ipcRenderer.invoke('photocull:generate-demo', count),
  revealInFolder: (dir, file) => ipcRenderer.invoke('photocull:reveal-in-folder', dir, file),
  resolveDroppedFolder: (droppedPath) => ipcRenderer.invoke('photocull:resolve-dropped-folder', droppedPath),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  onMenuAction: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, data: MenuActionEvent) => handler(data);
    ipcRenderer.on('photocull:menu-action', listener);
    return () => ipcRenderer.removeListener('photocull:menu-action', listener);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
