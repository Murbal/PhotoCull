import { useState } from 'react';
import { ArrowLeftRight, Crown, Link2, Link2Off, Star } from 'lucide-react';
import type { PhotoItem } from '../../shared/types.js';
import { FIT_VIEWPORT, LoupeCanvas, type ViewportTransform } from './LoupeCanvas.js';

interface CompareViewProps {
  folder: string;
  refItem: PhotoItem | null;
  candItem: PhotoItem | null;
  viewport: ViewportTransform;
  onViewportChange: (next: ViewportTransform) => void;
  showClipping: boolean;
  onSwap: () => void;
  onPromoteCandidate: () => void;
  onRate: (item: PhotoItem, rating: number) => void;
}

function PaneHeader({
  role,
  item,
  onRate,
}: {
  role: 'SELECT (LOCKED)' | 'CANDIDATE (ACTIVE)';
  item: PhotoItem | null;
  onRate: (item: PhotoItem, rating: number) => void;
}) {
  if (!item) return null;
  const exif = item.exif;

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[#141418] border-b border-white/[0.06] text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider ${
            role.startsWith('SELECT')
              ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
              : 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
          }`}
        >
          {role}
        </span>
        <span className="font-mono text-neutral-200 truncate">{item.displayName}</span>
        {exif && (
          <span className="hidden xl:inline text-[11px] text-neutral-500 tabular-nums truncate">
            {[
              exif.exposureTime,
              exif.fNumber ? `f/${exif.fNumber}` : null,
              exif.iso ? `ISO ${exif.iso}` : null,
              exif.focalLength ? `${exif.focalLength}mm` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </div>

      <div className="flex items-center shrink-0">
        {[1, 2, 3, 4, 5].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onRate(item, item.metadata.rating === s ? 0 : s)}
            className="p-0.5 hover:scale-110 transition"
            title={`Rate ${s} star${s > 1 ? 's' : ''}`}
          >
            <Star
              className={`h-3.5 w-3.5 ${
                item.metadata.rating >= s ? 'fill-amber-400 text-amber-400' : 'text-neutral-700'
              }`}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Side-by-Side 2-Up Compare View with synchronized 100%/200% zoom & pan.
 */
export function CompareView({
  folder,
  refItem,
  candItem,
  viewport,
  onViewportChange,
  showClipping,
  onSwap,
  onPromoteCandidate,
  onRate,
}: CompareViewProps) {
  const [syncPanZoom, setSyncPanZoom] = useState(true);
  const [rightViewport, setRightViewport] = useState<ViewportTransform>(FIT_VIEWPORT);

  const handleLeftChange = (next: ViewportTransform) => {
    onViewportChange(next);
    if (syncPanZoom) setRightViewport(next);
  };

  const handleRightChange = (next: ViewportTransform) => {
    if (syncPanZoom) {
      onViewportChange(next);
      setRightViewport(next);
    } else {
      setRightViewport(next);
    }
  };

  const effectiveRightViewport = syncPanZoom ? viewport : rightViewport;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0d0d0f]">
      {/* Compare control bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#121216] border-b border-white/[0.07] text-xs">
        <div className="flex items-center gap-2 text-neutral-400">
          <span className="font-medium text-neutral-200">2-Up Compare</span>
          <span className="text-neutral-600">·</span>
          <span>Use ← / → to step Candidate while Select stays pinned · Click or press Z for 100% synced focus check</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSyncPanZoom((s) => !s)}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs border transition ${
              syncPanZoom
                ? 'bg-amber-500/15 border-amber-500/40 text-amber-200'
                : 'bg-white/[0.03] border-white/10 text-neutral-400 hover:text-white'
            }`}
            title="Synchronize zoom and pan across both panes"
          >
            {syncPanZoom ? <Link2 className="h-3.5 w-3.5" /> : <Link2Off className="h-3.5 w-3.5" />}
            {syncPanZoom ? 'Synced Zoom/Pan' : 'Independent'}
          </button>
          <button
            type="button"
            onClick={onSwap}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs bg-white/[0.04] hover:bg-white/[0.09] border border-white/10 text-neutral-200 transition"
            title="Swap Select and Candidate (S)"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            Swap
          </button>
          <button
            type="button"
            onClick={onPromoteCandidate}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-200 transition"
            title="Promote Candidate to Select"
          >
            <Crown className="h-3.5 w-3.5" />
            Make Select
          </button>
        </div>
      </div>

      {/* Dual panes */}
      <div className="flex-1 grid grid-cols-2 divide-x divide-white/10 min-h-0">
        <div className="flex flex-col min-h-0">
          <PaneHeader role="SELECT (LOCKED)" item={refItem} onRate={onRate} />
          <div className="flex-1 min-h-0">
            <LoupeCanvas
              folder={folder}
              item={refItem}
              viewport={viewport}
              onViewportChange={handleLeftChange}
              showClipping={showClipping}
            />
          </div>
        </div>

        <div className="flex flex-col min-h-0">
          <PaneHeader role="CANDIDATE (ACTIVE)" item={candItem} onRate={onRate} />
          <div className="flex-1 min-h-0">
            <LoupeCanvas
              folder={folder}
              item={candItem}
              viewport={effectiveRightViewport}
              onViewportChange={handleRightChange}
              showClipping={showClipping}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
