import { ArrowUpDown, RotateCcw, Search, Star } from 'lucide-react';
import type {
  FilterState,
  FormatFilter,
  RatedFilter,
  SortDirection,
  SortField,
} from '../../shared/types.js';

interface FilterBarProps {
  filter: FilterState;
  sortField: SortField;
  sortDir: SortDirection;
  counts: {
    total: number;
    filtered: number;
    rated: number;
    unrated: number;
  };
  onFilterChange: (next: FilterState) => void;
  onSortChange: (field: SortField, dir: SortDirection) => void;
  onResetFilters: () => void;
}

export function FilterBar({
  filter,
  sortField,
  sortDir,
  counts,
  onFilterChange,
  onSortChange,
  onResetFilters,
}: FilterBarProps) {
  const hasActiveFilter =
    filter.rated !== 'all' ||
    filter.minRating > 0 ||
    filter.format !== 'all' ||
    filter.search.trim() !== '';

  const ratedTabs: { id: RatedFilter; label: string; count: number; accent?: string }[] = [
    { id: 'all', label: 'All', count: counts.total },
    { id: 'rated', label: 'Rated', count: counts.rated, accent: 'text-amber-300' },
    { id: 'unrated', label: 'Unrated', count: counts.unrated },
  ];

  return (
    <div className="h-9 shrink-0 bg-[#111115] border-b border-white/[0.06] px-3 flex items-center justify-between gap-3 text-[11px] overflow-x-auto">
      {/* Left: Rated / Unrated pills, Min Star >= N, Format */}
      <div className="flex items-center gap-2.5 shrink-0">
        <div className="flex items-center gap-0.5 rounded bg-[#0a0a0d] p-0.5 border border-white/[0.07]">
          {ratedTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() =>
                onFilterChange({
                  ...filter,
                  rated: t.id,
                  minRating: t.id === 'unrated' ? 0 : filter.minRating,
                })
              }
              className={`flex items-center gap-1 rounded px-2 py-0.5 transition ${
                filter.rated === t.id
                  ? 'bg-white/12 text-white font-medium'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              <span className={filter.rated === t.id ? '' : t.accent}>{t.label}</span>
              <span className="text-[10px] text-neutral-500 tabular-nums">{t.count}</span>
            </button>
          ))}
        </div>

        {/* Min Star Rating >= N */}
        <div className="flex items-center gap-0.5 border-l border-white/10 pl-2.5" title="Filter by minimum star rating">
          <span className="text-neutral-500 mr-1">≥</span>
          {[1, 2, 3, 4, 5].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() =>
                onFilterChange({
                  ...filter,
                  rated: filter.rated === 'unrated' ? 'all' : filter.rated,
                  minRating: filter.minRating === s ? 0 : s,
                })
              }
              className="p-0.5 hover:scale-110 transition"
              title={`Rating >= ${s} star${s > 1 ? 's' : ''}`}
            >
              <Star
                className={`h-3 w-3 ${
                  filter.minRating >= s ? 'fill-amber-400 text-amber-400' : 'text-neutral-700 hover:text-neutral-400'
                }`}
              />
            </button>
          ))}
        </div>

        {/* Format filter */}
        <select
          value={filter.format}
          onChange={(e) => onFilterChange({ ...filter, format: e.target.value as FormatFilter })}
          className="rounded bg-[#0b0b0e] border border-white/10 px-1.5 py-0.5 text-[11px] text-neutral-300 focus:outline-none focus:border-amber-400"
        >
          <option value="all">All Formats</option>
          <option value="raw">RAW Only</option>
          <option value="jpeg">JPEG / Image</option>
          <option value="paired">RAW+JPG Pairs</option>
        </select>

        {hasActiveFilter && (
          <button
            type="button"
            onClick={onResetFilters}
            className="flex items-center gap-1 rounded bg-amber-500/15 border border-amber-500/35 px-2 py-0.5 text-amber-200 hover:bg-amber-500/25 transition"
          >
            <RotateCcw className="h-3 w-3" />
            Reset ({counts.filtered}/{counts.total})
          </button>
        )}
      </div>

      {/* Right: Search & Sort */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-neutral-500" />
          <input
            type="text"
            value={filter.search}
            onChange={(e) => onFilterChange({ ...filter, search: e.target.value })}
            placeholder="Filter filename…"
            className="w-36 focus:w-48 transition-all rounded bg-[#0b0b0e] border border-white/10 pl-6 pr-2 py-0.5 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-amber-400/70"
          />
        </div>

        <div className="flex items-center gap-1">
          <select
            value={sortField}
            onChange={(e) => onSortChange(e.target.value as SortField, sortDir)}
            className="rounded bg-[#0b0b0e] border border-white/10 px-1.5 py-0.5 text-[11px] text-neutral-300 focus:outline-none focus:border-amber-400"
          >
            <option value="name">Sort: Filename</option>
            <option value="date">Sort: Date</option>
            <option value="rating">Sort: Rating</option>
            <option value="size">Sort: Size</option>
          </select>
          <button
            type="button"
            onClick={() => onSortChange(sortField, sortDir === 'asc' ? 'desc' : 'asc')}
            title={`Sort direction: ${sortDir.toUpperCase()}`}
            className="rounded bg-[#0b0b0e] border border-white/10 p-1 text-neutral-400 hover:text-white transition"
          >
            <ArrowUpDown className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
