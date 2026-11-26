import { useEffect, useRef } from 'react';
import type { HistogramData } from '../engine/histogram.js';

interface HistogramViewProps {
  data: HistogramData | null;
  clippingActive: boolean;
  onToggleClipping?: () => void;
}

export function HistogramView({ data, clippingActive, onToggleClipping }: HistogramViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Subtle EV stop guide lines (quarters)
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const gx = Math.round((w * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.stroke();
    }

    if (!data) return;

    const drawChannel = (bins: Uint32Array, fillStyle: string, strokeStyle: string) => {
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * w;
        const norm = Math.min(1, bins[i] / (data.maxBin * 1.1));
        const y = h - norm * (h - 4);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = fillStyle;
      ctx.fill();
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    ctx.globalCompositeOperation = 'lighter';
    drawChannel(data.r, 'rgba(239, 68, 68, 0.32)', 'rgba(248, 113, 113, 0.65)');
    drawChannel(data.g, 'rgba(34, 197, 94, 0.30)', 'rgba(74, 222, 128, 0.60)');
    drawChannel(data.b, 'rgba(59, 130, 246, 0.34)', 'rgba(96, 165, 250, 0.68)');
    ctx.globalCompositeOperation = 'source-over';
    drawChannel(data.luma, 'rgba(228, 228, 231, 0.14)', 'rgba(244, 244, 245, 0.45)');
  }, [data]);

  const hasShadowClip = (data?.clippedShadowsPct ?? 0) >= 0.4;
  const hasHighClip = (data?.clippedHighlightsPct ?? 0) >= 0.4;

  return (
    <div className="relative rounded-md bg-black/75 border border-white/10 p-1.5 backdrop-blur-md">
      <div className="flex items-center justify-between mb-1 px-0.5 text-[10px] tracking-wider uppercase text-neutral-400">
        <button
          type="button"
          onClick={onToggleClipping}
          title="Shadow clipping indicator (press O to toggle overlay)"
          className={`flex items-center gap-1 rounded px-1 py-0.5 transition ${
            clippingActive ? 'bg-blue-500/20 text-blue-300' : 'hover:text-neutral-200'
          }`}
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              hasShadowClip ? 'bg-blue-400 shadow-[0_0_6px_#60a5fa]' : 'bg-neutral-600'
            }`}
          />
          <span>SHD</span>
        </button>
        <span className="text-[9px] text-neutral-500 font-medium">RGB</span>
        <button
          type="button"
          onClick={onToggleClipping}
          title="Highlight clipping indicator (press O to toggle overlay)"
          className={`flex items-center gap-1 rounded px-1 py-0.5 transition ${
            clippingActive ? 'bg-red-500/20 text-red-300' : 'hover:text-neutral-200'
          }`}
        >
          <span>HLT</span>
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              hasHighClip ? 'bg-red-400 shadow-[0_0_6px_#f87171]' : 'bg-neutral-600'
            }`}
          />
        </button>
      </div>
      <canvas ref={canvasRef} width={200} height={64} className="block w-[200px] h-[64px] rounded-xs" />
    </div>
  );
}
