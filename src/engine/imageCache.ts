import type { PhotoItem } from '../../shared/types.js';
import { buildImageUrl } from '../api/client.js';

export interface DecodedFrame {
  key: string;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  orientation: number;
  decodeMs: number;
}

/**
 * High-performance off-main-thread ImageBitmap LRU cache with directional prefetching
 * and automatic AbortController cancellation for zero-lag frame switching (<16ms).
 */
export class FrameCacheEngine {
  private readonly cache = new Map<string, DecodedFrame>();
  private readonly inflight = new Map<string, { promise: Promise<DecodedFrame | null>; abort: AbortController }>();
  private readonly maxEntries: number;
  private activePrefetchKeys = new Set<string>();

  constructor(maxEntries = 36) {
    this.maxEntries = maxEntries;
  }

  getKey(folder: string, item: PhotoItem, variant: 'preview' | 'thumb'): string {
    return `${folder}::${item.id}::${item.mtimeMs}::${variant}`;
  }

  getSync(key: string): DecodedFrame | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    // Refresh LRU order
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit;
  }

  private put(key: string, frame: DecodedFrame): void {
    const existing = this.cache.get(key);
    if (existing) {
      if (existing.bitmap !== frame.bitmap) {
        try { existing.bitmap.close(); } catch { /* ignore */ }
      }
      this.cache.delete(key);
    }
    this.cache.set(key, frame);

    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      if (evicted) {
        try { evicted.bitmap.close(); } catch { /* ignore */ }
      }
    }
  }

  async loadFrame(
    folder: string,
    item: PhotoItem,
    variant: 'preview' | 'thumb',
    priority: 'high' | 'low' = 'high',
  ): Promise<DecodedFrame | null> {
    const key = this.getKey(folder, item, variant);
    const hit = this.getSync(key);
    if (hit) return hit;

    const existing = this.inflight.get(key);
    if (existing) return existing.promise;

    const abort = new AbortController();
    const url = buildImageUrl(folder, item, variant, true);

    const promise = (async (): Promise<DecodedFrame | null> => {
      const t0 = performance.now();
      try {
        const res = await fetch(url, {
          signal: abort.signal,
          priority: priority === 'high' ? 'high' : 'low',
        } as RequestInit);

        if (!res.ok) return null;

        const orientation = Number(res.headers.get('X-Exif-Orientation') || '1') || 1;
        const blob = await res.blob();
        if (abort.signal.aborted) return null;

        // Decode off main thread via native hardware/libjpeg-turbo decoder!
        // Respects embedded EXIF orientation automatically when supported.
        const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        if (abort.signal.aborted) {
          bitmap.close();
          return null;
        }

        const frame: DecodedFrame = {
          key,
          bitmap,
          width: bitmap.width,
          height: bitmap.height,
          orientation,
          decodeMs: Math.round(performance.now() - t0),
        };
        this.put(key, frame);
        return frame;
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError') return null;
        return null;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, { promise, abort });
    return promise;
  }

  /**
   * Prefetches `ahead` frames forward and `behind` frames backward around `currentIndex`,
   * cancelling stale background fetches that fell outside the active culling window.
   */
  prefetchWindow(
    folder: string,
    items: PhotoItem[],
    currentIndex: number,
    ahead = 8,
    behind = 4,
  ): void {
    if (!folder || items.length === 0 || currentIndex < 0) return;

    // Build ordered priority indices: +1, +2, -1, +3, +4, -2, +5, ...
    const orderedOffsets: number[] = [];
    const maxStep = Math.max(ahead, behind);
    for (let step = 1; step <= maxStep; step++) {
      if (step <= ahead) orderedOffsets.push(step);
      if (step <= behind) orderedOffsets.push(-step);
    }

    const desiredKeys = new Set<string>();
    const currentItem = items[currentIndex];
    if (currentItem) desiredKeys.add(this.getKey(folder, currentItem, 'preview'));

    const targets: PhotoItem[] = [];
    for (const off of orderedOffsets) {
      const idx = currentIndex + off;
      if (idx >= 0 && idx < items.length) {
        const it = items[idx];
        desiredKeys.add(this.getKey(folder, it, 'preview'));
        targets.push(it);
      }
    }

    // Cancel stale low-priority prefetches that are no longer near the cursor
    for (const [key, entry] of this.inflight.entries()) {
      if (!desiredKeys.has(key) && this.activePrefetchKeys.has(key)) {
        entry.abort.abort();
        this.inflight.delete(key);
      }
    }
    this.activePrefetchKeys = desiredKeys;

    // Fire up to 4 concurrent background decodes ahead/behind
    let started = 0;
    for (const target of targets) {
      const key = this.getKey(folder, target, 'preview');
      if (this.cache.has(key) || this.inflight.has(key)) continue;
      void this.loadFrame(folder, target, 'preview', 'low');
      started++;
      if (started >= 4) break;
    }
  }

  clear(): void {
    for (const entry of this.inflight.values()) {
      entry.abort.abort();
    }
    this.inflight.clear();
    for (const frame of this.cache.values()) {
      try { frame.bitmap.close(); } catch { /* ignore */ }
    }
    this.cache.clear();
    this.activePrefetchKeys.clear();
  }

  getStats(): { cachedCount: number; maxEntries: number; inflightCount: number } {
    return {
      cachedCount: this.cache.size,
      maxEntries: this.maxEntries,
      inflightCount: this.inflight.size,
    };
  }
}

export const previewFrameCache = new FrameCacheEngine(36);
export const thumbFrameCache = new FrameCacheEngine(220);
