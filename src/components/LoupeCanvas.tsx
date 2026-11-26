import { useCallback, useEffect, useRef, useState } from 'react';
import type { PhotoItem } from '../../shared/types.js';
import { type DecodedFrame, previewFrameCache } from '../engine/imageCache.js';
import { computeHistogram, type HistogramData } from '../engine/histogram.js';

export interface ViewportTransform {
  zoomMode: 'fit' | '100' | '200' | 'custom';
  scale: number;     // used when zoomMode === 'custom' (1.0 = 100% physical pixels)
  panX: number;      // normalized offset relative to image center in image pixels
  panY: number;
}

export const FIT_VIEWPORT: ViewportTransform = {
  zoomMode: 'fit',
  scale: 1,
  panX: 0,
  panY: 0,
};

interface LoupeCanvasProps {
  folder: string;
  item: PhotoItem | null;
  viewport: ViewportTransform;
  onViewportChange: (next: ViewportTransform) => void;
  showClipping?: boolean;
  onHistogram?: (data: HistogramData | null) => void;
  onFrameLoaded?: (frame: DecodedFrame | null) => void;
  className?: string;
}

// Compute clipping overlay bitmap on demand for highlight/shadow warning
function buildClippingCanvas(bitmap: ImageBitmap): HTMLCanvasElement {
  const maxDim = 960;
  const ratio = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * ratio));
  const h = Math.max(1, Math.round(bitmap.height * ratio));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    if (r >= 253 || g >= 253 || b >= 253) {
      d[i] = 255;
      d[i + 1] = 36;
      d[i + 2] = 36;
      d[i + 3] = 210;
    } else if (r <= 2 && g <= 2 && b <= 2) {
      d[i] = 36;
      d[i + 1] = 110;
      d[i + 2] = 255;
      d[i + 3] = 210;
    } else {
      d[i + 3] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function LoupeCanvas({
  folder,
  item,
  viewport,
  onViewportChange,
  showClipping = false,
  onHistogram,
  onFrameLoaded,
  className = '',
}: LoupeCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [frame, setFrame] = useState<DecodedFrame | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const clippingCacheRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);

  // Drag-pan state
  const dragRef = useRef<{
    active: boolean;
    moved: boolean;
    startX: number;
    startY: number;
    origPanX: number;
    origPanY: number;
  }>({ active: false, moved: false, startX: 0, startY: 0, origPanX: 0, origPanY: 0 });

  // Track container dimensions smoothly with ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ w: Math.max(1, Math.floor(width)), h: Math.max(1, Math.floor(height)) });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Load current frame — synchronous hit from ImageBitmap LRU cache (<1ms) when prefetched!
  useEffect(() => {
    if (!folder || !item) {
      setFrame(null);
      setLoading(false);
      setErrorMsg(null);
      onHistogram?.(null);
      onFrameLoaded?.(null);
      return;
    }

    const key = previewFrameCache.getKey(folder, item, 'preview');
    const syncHit = previewFrameCache.getSync(key);
    if (syncHit) {
      setFrame(syncHit);
      setLoading(false);
      setErrorMsg(null);
      onFrameLoaded?.(syncHit);
      if (onHistogram) {
        onHistogram(computeHistogram(syncHit.key, syncHit.bitmap));
      }
      return;
    }

    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);

    previewFrameCache.loadFrame(folder, item, 'preview', 'high').then((loaded) => {
      if (cancelled) return;
      setLoading(false);
      if (loaded) {
        setFrame(loaded);
        onFrameLoaded?.(loaded);
        if (onHistogram) {
          onHistogram(computeHistogram(loaded.key, loaded.bitmap));
        }
      } else {
        setFrame(null);
        setErrorMsg('No embedded preview available for this file.');
        onHistogram?.(null);
        onFrameLoaded?.(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [folder, item, onHistogram, onFrameLoaded]);

  const computeEffectiveScale = useCallback(
    (f: DecodedFrame, viewW: number, viewH: number, dpr: number): number => {
      const fitScale = Math.min((viewW * dpr) / f.width, (viewH * dpr) / f.height) * 0.985;
      if (viewport.zoomMode === 'fit') return fitScale;
      if (viewport.zoomMode === '100') return 1.0; // 1 image px = 1 physical device px (true 100% sharpness check!)
      if (viewport.zoomMode === '200') return 2.0;
      return viewport.scale;
    },
    [viewport.zoomMode, viewport.scale],
  );

  // Draw frame to GPU canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasSize.w === 0 || canvasSize.h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const physW = Math.round(canvasSize.w * dpr);
    const physH = Math.round(canvasSize.h * dpr);
    if (canvas.width !== physW || canvas.height !== physH) {
      canvas.width = physW;
      canvas.height = physH;
    }

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    // Neutral darkroom canvas backdrop
    ctx.fillStyle = '#0d0d0f';
    ctx.fillRect(0, 0, physW, physH);

    if (!frame) return;

    const effScale = computeEffectiveScale(frame, canvasSize.w, canvasSize.h, dpr);
    const drawW = frame.width * effScale;
    const drawH = frame.height * effScale;

    const cx = physW / 2 - viewport.panX * effScale;
    const cy = physH / 2 - viewport.panY * effScale;
    const dx = Math.round(cx - drawW / 2);
    const dy = Math.round(cy - drawH / 2);

    // Use crisp nearest-neighbor at >= 200% zoom so pixel-level focus/moiré is unmistakable
    ctx.imageSmoothingEnabled = effScale < 1.95;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame.bitmap, dx, dy, drawW, drawH);

    // Optional highlight/shadow clipping overlay
    if (showClipping) {
      if (!clippingCacheRef.current || clippingCacheRef.current.key !== frame.key) {
        clippingCacheRef.current = {
          key: frame.key,
          canvas: buildClippingCanvas(frame.bitmap),
        };
      }
      ctx.drawImage(clippingCacheRef.current.canvas, dx, dy, drawW, drawH);
    }

    // Subtle minimap navigator when zoomed in beyond viewport bounds
    if (viewport.zoomMode !== 'fit' && (drawW > physW + 4 || drawH > physH + 4)) {
      const mapMaxW = 132 * dpr;
      const aspect = frame.width / frame.height;
      const mw = aspect >= 1 ? mapMaxW : mapMaxW * aspect;
      const mh = aspect >= 1 ? mapMaxW / aspect : mapMaxW;
      const pad = 14 * dpr;
      const mx = physW - mw - pad;
      const my = pad + 44 * dpr;

      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.68)';
      ctx.fillRect(mx - 3 * dpr, my - 3 * dpr, mw + 6 * dpr, mh + 6 * dpr);
      ctx.globalAlpha = 0.82;
      ctx.drawImage(frame.bitmap, mx, my, mw, mh);
      ctx.globalAlpha = 1;

      // Viewport rectangle inside minimap
      const visLeft = Math.max(0, (0 - dx) / drawW);
      const visTop = Math.max(0, (0 - dy) / drawH);
      const visRight = Math.min(1, (physW - dx) / drawW);
      const visBottom = Math.min(1, (physH - dy) / drawH);

      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeRect(
        mx + visLeft * mw,
        my + visTop * mh,
        Math.max(4, (visRight - visLeft) * mw),
        Math.max(4, (visBottom - visTop) * mh),
      );
      ctx.restore();
    }
  }, [frame, canvasSize, viewport, showClipping, computeEffectiveScale]);

  const clampPan = useCallback(
    (panX: number, panY: number, scale: number, f: DecodedFrame): { panX: number; panY: number } => {
      const dpr = window.devicePixelRatio || 1;
      const physW = canvasSize.w * dpr;
      const physH = canvasSize.h * dpr;
      const maxX = Math.max(0, (f.width - physW / scale) / 2);
      const maxY = Math.max(0, (f.height - physH / scale) / 2);
      return {
        panX: Math.max(-maxX, Math.min(maxX, panX)),
        panY: Math.max(-maxY, Math.min(maxY, panY)),
      };
    },
    [canvasSize],
  );

  // Single-click toggles 100% focus zoom at exact clicked image pixel (or back to Fit)
  const toggleZoomAtClientPoint = useCallback(
    (clientX: number, clientY: number) => {
      if (!frame || !containerRef.current) return;
      if (viewport.zoomMode !== 'fit') {
        onViewportChange(FIT_VIEWPORT);
        return;
      }

      const rect = containerRef.current.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const clickX = (clientX - rect.left) * dpr;
      const clickY = (clientY - rect.top) * dpr;
      const physW = rect.width * dpr;
      const physH = rect.height * dpr;

      const fitScale = computeEffectiveScale(frame, rect.width, rect.height, dpr);
      // Image pixel offset from image center under the cursor
      const imgOffsetX = (clickX - physW / 2) / fitScale;
      const imgOffsetY = (clickY - physH / 2) / fitScale;
      const clamped = clampPan(imgOffsetX, imgOffsetY, 1.0, frame);

      onViewportChange({
        zoomMode: '100',
        scale: 1.0,
        panX: clamped.panX,
        panY: clamped.panY,
      });
    },
    [frame, viewport.zoomMode, computeEffectiveScale, clampPan, onViewportChange],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !frame) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      origPanX: viewport.panX,
      origPanY: viewport.panY,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active || !frame) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (Math.hypot(dx, dy) > 4) {
      dragRef.current.moved = true;
    }
    if (viewport.zoomMode === 'fit' || !dragRef.current.moved) return;

    const dpr = window.devicePixelRatio || 1;
    const effScale = computeEffectiveScale(frame, canvasSize.w, canvasSize.h, dpr);
    const nextPanX = dragRef.current.origPanX - (dx * dpr) / effScale;
    const nextPanY = dragRef.current.origPanY - (dy * dpr) / effScale;
    const clamped = clampPan(nextPanX, nextPanY, effScale, frame);
    onViewportChange({
      ...viewport,
      panX: clamped.panX,
      panY: clamped.panY,
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    const wasMoved = dragRef.current.moved;
    dragRef.current.active = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!wasMoved) {
      toggleZoomAtClientPoint(e.clientX, e.clientY);
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!frame || !containerRef.current) return;
    // Allow Ctrl+Wheel or wheel when already zoomed to smoothly scale
    if (!e.ctrlKey && !e.metaKey && viewport.zoomMode === 'fit') return;
    e.preventDefault();

    const dpr = window.devicePixelRatio || 1;
    const currentScale = computeEffectiveScale(frame, canvasSize.w, canvasSize.h, dpr);
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    const fitScale = Math.min((canvasSize.w * dpr) / frame.width, (canvasSize.h * dpr) / frame.height) * 0.985;
    const nextScale = Math.max(fitScale, Math.min(4.0, currentScale * factor));

    if (nextScale <= fitScale * 1.03) {
      onViewportChange(FIT_VIEWPORT);
      return;
    }

    const clamped = clampPan(viewport.panX, viewport.panY, nextScale, frame);
    onViewportChange({
      zoomMode: 'custom',
      scale: nextScale,
      panX: clamped.panX,
      panY: clamped.panY,
    });
  };

  const zoomLabel =
    viewport.zoomMode === 'fit'
      ? 'FIT'
      : viewport.zoomMode === '100'
        ? '100%'
        : viewport.zoomMode === '200'
          ? '200%'
          : `${Math.round(viewport.scale * 100)}%`;

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
      className={`relative w-full h-full overflow-hidden bg-[#0d0d0f] select-none ${
        viewport.zoomMode === 'fit' ? 'cursor-zoom-in' : 'cursor-grab active:cursor-grabbing'
      } ${className}`}
    >
      <canvas ref={canvasRef} className="block w-full h-full" />

      {/* Subtle zoom indicator pill */}
      {frame && (
        <div className="pointer-events-none absolute top-3 right-3 flex items-center gap-1.5">
          {showClipping && (
            <span className="rounded bg-red-500/20 border border-red-500/40 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-red-300 backdrop-blur-md">
              CLIPPING
            </span>
          )}
          <span
            className={`rounded px-2 py-0.5 text-[11px] font-semibold tracking-wider tabular-nums backdrop-blur-md border ${
              viewport.zoomMode === 'fit'
                ? 'bg-black/55 border-white/10 text-neutral-300'
                : 'bg-amber-500/20 border-amber-400/40 text-amber-200'
            }`}
          >
            {zoomLabel}
          </span>
        </div>
      )}

      {loading && !frame && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-600 border-t-amber-400" />
        </div>
      )}

      {errorMsg && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
          <div className="rounded-lg border border-white/10 bg-neutral-900/90 px-4 py-3 text-sm text-neutral-400">
            {errorMsg}
          </div>
        </div>
      )}
    </div>
  );
}
