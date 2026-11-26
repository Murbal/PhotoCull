import { Star } from 'lucide-react';
import type { PhotoItem } from '../../shared/types.js';
import type { HistogramData } from '../engine/histogram.js';
import { HistogramView } from './HistogramView.js';
import { formatBytes, formatExifStrip } from './MetadataBadges.js';

interface InfoHudProps {
  item: PhotoItem;
  index: number;
  total: number;
  histogram: HistogramData | null;
  clippingActive: boolean;
  decodeMs: number | null;
  onRate: (rating: number) => void;
  onToggleClipping: () => void;
}

export function InfoHud({
  item,
  index,
  total,
  histogram,
  clippingActive,
  decodeMs,
  onRate,
  onToggleClipping,
}: InfoHudProps) {
  const exifParts = formatExifStrip(item.exif);
  const dims =
    item.exif?.width && item.exif?.height
      ? `${item.exif.width}×${item.exif.height}`
      : null;

  return (
    <>
      {/* Top-left floating RGB Histogram */}
      <div className="absolute top-3 left-3 z-20">
        <HistogramView
          data={histogram}
          clippingActive={clippingActive}
          onToggleClipping={onToggleClipping}
        />
      </div>

      {/* Bottom floating Minimal Info & Rating Strip */}
      <div className="absolute bottom-3 left-3 right-3 z-20 pointer-events-none flex justify-center">
        <div className="pointer-events-auto max-w-full flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-lg bg-black/80 border border-white/12 px-3.5 py-2 backdrop-blur-md shadow-2xl text-xs">
          {/* Left: File identity & EXIF */}
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-[11px] font-mono text-neutral-400 tabular-nums shrink-0">
              {index + 1} / {total}
            </span>
            <span className="font-mono font-medium text-neutral-100 truncate max-w-[220px]">
              {item.displayName}
            </span>
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 shrink-0">
              {item.kind === 'raw+jpeg'
                ? `${item.rawExt}+${item.jpegExt}`
                : item.rawExt || item.jpegExt}
            </span>
            <span className="hidden md:inline text-[11px] text-neutral-400 tabular-nums shrink-0">
              {formatBytes(item.sizeBytes)}
              {dims ? ` · ${dims}` : ''}
            </span>
            {exifParts.length > 0 && (
              <span className="hidden lg:inline text-[11px] text-neutral-300 tabular-nums truncate max-w-[440px] border-l border-white/15 pl-2.5">
                {exifParts.join(' · ')}
              </span>
            )}
            {decodeMs !== null && (
              <span
                title="Frame decode/switch latency"
                className="hidden xl:inline text-[10px] font-mono text-emerald-400/80 tabular-nums"
              >
                {decodeMs <= 1 ? '<1ms' : `${decodeMs}ms`}
              </span>
            )}
          </div>

          {/* Right: Interactive 1–5 Star Rating */}
          <div className="flex items-center gap-0.5 shrink-0 border-l border-white/15 pl-2.5">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => onRate(item.metadata.rating === star ? 0 : star)}
                title={`Rate ${star} (${star})`}
                className="p-0.5 hover:scale-110 transition"
              >
                <Star
                  className={`h-4 w-4 ${
                    item.metadata.rating >= star
                      ? 'fill-amber-400 text-amber-400'
                      : 'text-neutral-600 hover:text-neutral-400'
                  }`}
                />
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
