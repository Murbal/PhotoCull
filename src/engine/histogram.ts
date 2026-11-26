export interface HistogramData {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  maxBin: number;
  clippedHighlightsPct: number;
  clippedShadowsPct: number;
}

const histCache = new Map<string, HistogramData>();
let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;

function getScratchContext(): CanvasRenderingContext2D {
  if (!offscreenCanvas) {
    offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = 180;
    offscreenCanvas.height = 120;
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
  }
  return offscreenCtx!;
}

/**
 * Computes a 256-bin RGB + Luminance histogram from a decoded ImageBitmap in <1ms.
 */
export function computeHistogram(cacheKey: string, bitmap: ImageBitmap): HistogramData {
  const cached = histCache.get(cacheKey);
  if (cached) return cached;

  const ctx = getScratchContext();
  const w = 180;
  const h = 120;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);

  const imgData = ctx.getImageData(0, 0, w, h).data;
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const luma = new Uint32Array(256);

  const totalPixels = w * h;
  let clippedHigh = 0;
  let clippedLow = 0;

  for (let i = 0; i < imgData.length; i += 4) {
    const rv = imgData[i];
    const gv = imgData[i + 1];
    const bv = imgData[i + 2];
    const lv = (rv * 77 + gv * 150 + bv * 29) >> 8;

    r[rv]++;
    g[gv]++;
    b[bv]++;
    luma[lv]++;

    if (rv >= 253 || gv >= 253 || bv >= 253) clippedHigh++;
    if (rv <= 2 && gv <= 2 && bv <= 2) clippedLow++;
  }

  // Compute robust peak (ignore extreme 0 and 255 spikes so midtones remain readable)
  let maxBin = 1;
  for (let i = 3; i <= 252; i++) {
    if (r[i] > maxBin) maxBin = r[i];
    if (g[i] > maxBin) maxBin = g[i];
    if (b[i] > maxBin) maxBin = b[i];
    if (luma[i] > maxBin) maxBin = luma[i];
  }

  const data: HistogramData = {
    r,
    g,
    b,
    luma,
    maxBin,
    clippedHighlightsPct: (clippedHigh / totalPixels) * 100,
    clippedShadowsPct: (clippedLow / totalPixels) * 100,
  };

  if (histCache.size > 100) {
    const first = histCache.keys().next().value;
    if (first !== undefined) histCache.delete(first);
  }
  histCache.set(cacheKey, data);
  return data;
}
