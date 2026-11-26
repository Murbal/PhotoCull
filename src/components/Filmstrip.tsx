import { useEffect, useRef } from 'react';
import type { PhotoItem } from '../../shared/types.js';
import { buildImageUrl } from '../api/client.js';

interface FilmstripProps {
  folder: string;
  items: PhotoItem[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

/**
 * Lightweight windowed bottom filmstrip for Loupe & Compare views.
 */
export function Filmstrip({ folder, items, activeIndex, onSelect }: FilmstripProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const windowHalf = 30;
  const start = Math.max(0, activeIndex - windowHalf);
  const end = Math.min(items.length, activeIndex + windowHalf + 1);
  const slice = items.slice(start, end);

  useEffect(() => {
    activeRef.current?.scrollIntoView({
      behavior: 'auto',
      inline: 'center',
      block: 'nearest',
    });
  }, [activeIndex]);

  if (items.length === 0) return null;

  return (
    <div className="h-[88px] shrink-0 bg-[#111115] border-t border-white/[0.07] px-3 flex items-center gap-1.5 overflow-x-auto">
      {start > 0 && (
        <div className="shrink-0 text-[10px] text-neutral-500 px-2 tabular-nums">
          +{start}
        </div>
      )}
      {slice.map((item, offset) => {
        const idx = start + offset;
        const isActive = idx === activeIndex;

        return (
          <button
            key={item.id}
            ref={isActive ? activeRef : undefined}
            type="button"
            onClick={() => onSelect(idx)}
            className={`relative shrink-0 h-[68px] w-[96px] rounded overflow-hidden bg-[#0a0a0c] transition ${
              isActive
                ? 'ring-2 ring-amber-400 scale-[1.03] z-10'
                : 'ring-1 ring-white/10 opacity-75 hover:opacity-100'
            }`}
          >
            <img
              src={buildImageUrl(folder, item, 'thumb', true)}
              alt={item.displayName}
              loading="lazy"
              decoding="async"
              draggable={false}
              className="w-full h-full object-cover"
            />
            {item.metadata.rating > 0 && (
              <span className="absolute bottom-0.5 left-1 text-[9px] font-bold text-amber-300 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                {'★'.repeat(item.metadata.rating)}
              </span>
            )}
          </button>
        );
      })}
      {end < items.length && (
        <div className="shrink-0 text-[10px] text-neutral-500 px-2 tabular-nums">
          +{items.length - end}
        </div>
      )}
    </div>
  );
}
