import type {
  BatchActionRequest,
  BatchActionResult,
  BrowseResult,
  ExifData,
  FolderScanResult,
  IngestRequest,
  IngestResult,
  MetadataPatchRequest,
  PhotoItem,
  PhotoMetadata,
} from '../../shared/types.js';

export function isElectronApp(): boolean {
  return typeof window !== 'undefined' && Boolean(window.electronAPI?.isElectron);
}

export function getDesktopPlatform(): string {
  return window.electronAPI?.platform ?? 'web';
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody.error) msg = errBody.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export function getHealth(): Promise<{
  ok: boolean;
  version: string;
  initialFolder: string;
  cwd: string;
}> {
  if (window.electronAPI) {
    return window.electronAPI.getInitialInfo();
  }
  return apiJson('/api/health');
}

export async function pickNativeFolder(opts?: {
  title?: string;
  defaultPath?: string;
}): Promise<string | null> {
  if (window.electronAPI) {
    return window.electronAPI.pickFolder(opts);
  }
  return null;
}

export async function revealInFileManager(folder: string, file: string): Promise<boolean> {
  if (window.electronAPI) {
    return window.electronAPI.revealInFolder(folder, file);
  }
  return false;
}

export function browseDir(dir?: string): Promise<BrowseResult> {
  if (window.electronAPI) {
    return window.electronAPI.browse(dir);
  }
  const qs = dir ? `?dir=${encodeURIComponent(dir)}` : '';
  return apiJson(`/api/browse${qs}`);
}

export function scanFolderApi(dir: string, pairing: boolean): Promise<FolderScanResult> {
  if (window.electronAPI) {
    return window.electronAPI.scanFolder(dir, pairing);
  }
  return apiJson(`/api/folder?dir=${encodeURIComponent(dir)}&pairing=${pairing ? 'true' : 'false'}`);
}

export function buildImageUrl(
  folder: string,
  item: PhotoItem,
  variant: 'thumb' | 'preview',
  preferPairedJpeg = true,
): string {
  // When RAW+JPEG pairing is active, using the companion JPEG for full preview
  // guarantees full-res decoding while keeping RAW & JPEG metadata synced!
  const file = preferPairedJpeg && item.jpegFile ? item.jpegFile : item.primaryFile;
  const fallback = file !== item.primaryFile ? item.primaryFile : (item.jpegFile ?? '');
  const params = new URLSearchParams({
    dir: folder,
    file,
    variant,
  });
  if (fallback) params.set('fallback', fallback);

  // Inside Electron, stream directly via privileged `photocull://` protocol (zero HTTP socket overhead!)
  if (isElectronApp()) {
    return `photocull://image?${params.toString()}`;
  }
  return `/api/image?${params.toString()}`;
}

export function fetchExif(folder: string, file: string): Promise<{ file: string; exif: ExifData }> {
  if (window.electronAPI) {
    return window.electronAPI.fetchExif(folder, file);
  }
  return apiJson(`/api/exif?dir=${encodeURIComponent(folder)}&file=${encodeURIComponent(file)}`);
}

export function fetchExifBatch(
  folder: string,
  files: string[],
): Promise<{ exif: Record<string, ExifData> }> {
  if (window.electronAPI) {
    return window.electronAPI.fetchExifBatch(folder, files);
  }
  return apiJson('/api/exif/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: folder, files }),
  });
}

export function patchMetadataApi(
  req: MetadataPatchRequest,
): Promise<{ itemId: string; metadata: PhotoMetadata }> {
  if (window.electronAPI) {
    return window.electronAPI.patchMetadata(req);
  }
  return apiJson('/api/metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

export function runBatchActionApi(req: BatchActionRequest): Promise<BatchActionResult> {
  if (window.electronAPI) {
    return window.electronAPI.runBatchAction(req);
  }
  return apiJson('/api/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

export function runIngestApi(req: IngestRequest): Promise<IngestResult> {
  if (window.electronAPI) {
    return window.electronAPI.runIngest(req);
  }
  return apiJson('/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

export function generateDemoShootApi(count = 24): Promise<{ folder: string; created: number }> {
  if (window.electronAPI) {
    return window.electronAPI.generateDemo(count);
  }
  return apiJson('/api/demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  });
}
