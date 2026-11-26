import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import type { PhotoItem } from '../../shared/types.js';
import { buildImageUrl } from '../api/client.js';

interface ContactSheetProps {
  folder: string;
  items: PhotoItem[];
  activeIndex: number;
  selectedIds: Set<string>;
  thumbSize: number;
  onSelect: (index: number, e: React.MouseEvent) => void;
  onOpenLoupe: (index: number) => void;
  onRate: (item: PhotoItem, rating: number) => void;
}

const GridCard = memo(function GridCard({
  folder,
  item,
  index,
  isActive,
  isSelected,
  cardWidth,
  cardHeight,
  onSelect,
  onOpenLoupe,
  onRate,
}: {
  folder: string;
  item: PhotoItem;
  index: number;
  isActive: boolean;
  isSelected: boolean;
  cardWidth: number;
  cardHeight: number;
  onSelect: (index: number, e: React.MouseEvent) => void;
  onOpenLoupe: (index: number) => void;
  onRate: (item: PhotoItem, rating: number) => void;
}) {
  const thumbUrl = useMemo(() => buildImageUrl(folder, item, 'thumb', true), [folder, item]);
  const compact = cardWidth < 155;

  return (
    <div
      style={{ width: cardWidth, height: cardHeight }}
      onClick={(e) => onSelect(index, e)}
      onDoubleClick={() => onOpenLoupe(index)}
      className={`group relative flex flex-col rounded-md overflow-hidden transition-shadow cursor-pointer ${
        isActive
          ? 'bg-[#1f1f26] ring-2 ring-amber-400 shadow-[0_0_0_1px_rgba(251,191,36,0.4)]'
          : isSelected
            ? 'bg-[#1b1b22] ring-2 ring-sky-400/80'
            : 'bg-[#141418] ring-1 ring-white/[0.06] hover:ring-white/20'
      }`}
    >
      {/* Thumbnail viewport */}
      <div className="relative flex-1 min-h-0 bg-[#0b0b0d] flex items-center justify-center overflow-hidden">
        <img
          src={thumbUrl}
          alt={item.displayName}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="w-full h-full object-contain"
        />

        {/* Format badge (RAW / RAW+JPG) */}
        <div className="absolute top-1.5 left-1.5 flex items-center gap-1 pointer-events-none">
          {item.kind === 'raw+jpeg' ? (
            <span className="rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-amber-300 border border-amber-400/30">
              {item.rawExt}+{item.jpegExt}
            </span>
          ) : item.kind === 'raw' ? (
            <span className="rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-neutral-300 border border-white/10">
              {item.rawExt}
            </span>
          ) : (
            <span className="rounded bg-black/65 px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-neutral-400">
              {item.jpegExt}
            </span>
          )}
        </div>

        {/* XMP indicator badge */}
        {item.metadata.hasXmp && (
          <span
            title="XMP sidecar synced"
            className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1 py-[1px] text-[8px] font-mono text-neutral-400 border border-white/10"
          >
            XMP
          </span>
        )}
      </div>

      {/* Footer info strip */}
      <div className="shrink-0 px-2 py-1.5 flex items-center justify-between gap-1 bg-[#141418] border-t border-white/[0.04]">
        <span
          className={`truncate font-mono ${compact ? 'text-[10px]' : 'text-[11px]'} ${
            isActive ? 'text-white font-medium' : 'text-neutral-300'
          }`}
          title={item.displayName}
        >
          {item.displayName}
        </span>

        {/* Interactive 1–5 star rating */}
        <div className="flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
          {[1, 2, 3, 4, 5].map((star) => {
            const filled = item.metadata.rating >= star;
            if (compact && !filled && item.metadata.rating === 0) return null;
            return (
              <button
                key={star}
                type="button"
                onClick={() => onRate(item, item.metadata.rating === star ? 0 : star)}
                className="p-[1px] text-neutral-600 hover:text-amber-300 transition"
                title={`Rate ${star} star${star > 1 ? 's' : ''}`}
              >
                <Star
                  className={`${compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} ${
                    filled ? 'fill-amber-400 text-amber-400' : 'text-neutral-700 group-hover:text-neutral-500'
                  }`}
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});

/**
 * Virtualized Contact Sheet capable of smoothly browsing 10,000+ RAW photos at 60fps.
 */
export function ContactSheet({
  folder,
  items,
  activeIndex,
  selectedIds,
  thumbSize,
  onSelect,
  onOpenLoupe,
  onRate,
}: ContactSheetProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(1200);
  const [viewportHeight, setViewportHeight] = useState(700);
  const [scrollTop, setScrollTop] = useState(0);

  const gap = 10;
  const padding = 14;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportWidth(entry.contentRect.width);
        setViewportHeight(entry.contentRect.height);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const usableWidth = Math.max(200, viewportWidth - padding * 2);
  const columns = Math.max(1, Math.floor((usableWidth + gap) / (thumbSize + gap)));
  const cardWidth = Math.floor((usableWidth - gap * (columns - 1)) / columns);
  const cardHeight = Math.round(cardWidth * 0.72) + 32;
  const rowHeight = cardHeight + gap;
  const totalRows = Math.ceil(items.length / columns);
  const totalHeight = Math.max(0, totalRows * rowHeight - gap + padding * 2);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || activeIndex < 0 || items.length === 0) return;
    const row = Math.floor(activeIndex / columns);
    const rowTop = padding + row * rowHeight;
    const rowBottom = rowTop + cardHeight;
    if (rowTop < el.scrollTop + padding) {
      el.scrollTop = Math.max(0, rowTop - padding);
    } else if (rowBottom > el.scrollTop + viewportHeight - padding) {
      el.scrollTop = rowBottom - viewportHeight + padding;
    }
  }, [activeIndex, columns, rowHeight, cardHeight, viewportHeight, items.length]);

  const overscan = 3;
  const startRow = Math.max(0, Math.floor((scrollTop - padding) / rowHeight) - overscan);
  const endRow = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);

  const visibleRows: number[] = [];
  for (let r = startRow; r <= endRow; r++) visibleRows.push(r);

  if (items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">
        No photos match the current filters.
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      data-grid-columns={columns}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="flex-1 overflow-y-auto overflow-x-hidden bg-[#0d0d0f] relative"
    >
      <div style={{ height: totalHeight, position: 'relative', width: '100%' }}>
        {visibleRows.map((row) => {
          const firstIdx = row * columns;
          const rowItems = items.slice(firstIdx, firstIdx + columns);
          const top = padding + row * rowHeight;
          return (
            <div
              key={row}
              style={{
                position: 'absolute',
                top,
                left: padding,
                right: padding,
                display: 'flex',
                gap,
              }}
            >
              {rowItems.map((item, colIdx) => {
                const idx = firstIdx + colIdx;
                return (
                  <GridCard
                    key={item.id}
                    folder={folder}
                    item={item}
                    index={idx}
                    isActive={idx === activeIndex}
                    isSelected={selectedIds.has(item.id)}
                    cardWidth={cardWidth}
                    cardHeight={cardHeight}
                    onSelect={onSelect}
                    onOpenLoupe={onOpenLoupe}
                    onRate={onRate}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
