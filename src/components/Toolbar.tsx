import {
  Columns2,
  Copy,
  Eye,
  FastForward,
  FolderOpen,
  FolderSearch,
  Grid2X2,
  Keyboard,
  Layers,
  Maximize2,
  PanelBottom,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { ViewMode } from '../../shared/types.js';
import { getDesktopPlatform, isElectronApp } from '../api/client.js';
import type { BatchModalTab } from './BatchActionModal.js';

interface ToolbarProps {
  folder: string;
  hasActiveItem?: boolean;
  scanMs: number | null;
  viewMode: ViewMode;
  pairingEnabled: boolean;
  autoAdvance: boolean;
  showHud: boolean;
  showFilmstrip: boolean;
  showClipping: boolean;
  thumbSize: number;
  ratedCount: number;
  onOpenFolder: () => void;
  onRevealCurrent?: () => void;
  onRefresh: () => void;
  onChangeView: (mode: ViewMode) => void;
  onTogglePairing: () => void;
  onToggleAutoAdvance: () => void;
  onToggleHud: () => void;
  onToggleFilmstrip: () => void;
  onToggleClipping: () => void;
  onThumbSizeChange: (size: number) => void;
  onOpenBatchModal: (tab: BatchModalTab) => void;
  onOpenShortcuts: () => void;
}

export function Toolbar({
  folder,
  hasActiveItem = false,
  scanMs,
  viewMode,
  pairingEnabled,
  autoAdvance,
  showHud,
  showFilmstrip,
  showClipping,
  thumbSize,
  ratedCount,
  onOpenFolder,
  onRevealCurrent,
  onRefresh,
  onChangeView,
  onTogglePairing,
  onToggleAutoAdvance,
  onToggleHud,
  onToggleFilmstrip,
  onToggleClipping,
  onThumbSizeChange,
  onOpenBatchModal,
  onOpenShortcuts,
}: ToolbarProps) {
  const folderName = folder ? folder.split(/[\\/]/).filter(Boolean).pop() || folder : 'No Folder';
  const isMacDesktop = isElectronApp() && getDesktopPlatform() === 'darwin';

  return (
    <header
      className={`h-11 shrink-0 bg-[#141418] border-b border-white/[0.08] pr-3 ${
        isMacDesktop ? 'pl-20 electron-drag' : 'pl-3'
      } flex items-center justify-between gap-2 text-xs`}
    >
      {/* Left: Brand & Folder */}
      <div className="flex items-center gap-2 min-w-0 electron-no-drag">
        <div className="flex items-center gap-1.5 font-semibold tracking-tight text-neutral-100 shrink-0">
          <img
            src="./icon.svg"
            alt=""
            className="h-6 w-6 rounded-md shrink-0"
            draggable={false}
          />
          <span className="hidden sm:inline">PhotoCull</span>
        </div>

        <div className="h-4 w-px bg-white/10" />

        <button
          type="button"
          onClick={onOpenFolder}
          title={folder || 'Open Folder'}
          className="flex items-center gap-1.5 rounded-md bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 px-2.5 py-1 text-neutral-200 max-w-[240px] transition"
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span className="truncate font-mono text-[11px]">{folderName}</span>
        </button>

        {folder && (
          <button
            type="button"
            onClick={onRefresh}
            title={`Rescan folder${scanMs !== null ? ` (last scan: ${scanMs}ms)` : ''}`}
            className="rounded p-1.5 text-neutral-400 hover:bg-white/[0.07] hover:text-white transition"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        )}

        {isElectronApp() && folder && hasActiveItem && onRevealCurrent && (
          <button
            type="button"
            onClick={onRevealCurrent}
            title="Reveal active photo in File Manager (Cmd/Ctrl+Shift+R)"
            className="rounded p-1.5 text-neutral-400 hover:bg-white/[0.07] hover:text-white transition"
          >
            <FolderSearch className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Center: View Switcher & Grid Size */}
      <div className="flex items-center gap-2 electron-no-drag">
        <div className="flex items-center rounded-md bg-[#0c0c0f] p-0.5 border border-white/10">
          <button
            type="button"
            onClick={() => onChangeView('grid')}
            title="Contact Sheet / Grid View (G)"
            className={`flex items-center gap-1 rounded px-2.5 py-1 transition ${
              viewMode === 'grid'
                ? 'bg-white/12 text-white font-medium'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Grid2X2 className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Grid</span>
          </button>
          <button
            type="button"
            onClick={() => onChangeView('loupe')}
            title="Single-Image Loupe View (G / Enter)"
            className={`flex items-center gap-1 rounded px-2.5 py-1 transition ${
              viewMode === 'loupe'
                ? 'bg-white/12 text-white font-medium'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Loupe</span>
          </button>
          <button
            type="button"
            onClick={() => onChangeView('compare')}
            title="2-Up Side-by-Side Compare (C)"
            className={`flex items-center gap-1 rounded px-2.5 py-1 transition ${
              viewMode === 'compare'
                ? 'bg-white/12 text-white font-medium'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Columns2 className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Compare</span>
          </button>
        </div>

        {viewMode === 'grid' && (
          <div className="hidden lg:flex items-center gap-1.5 pl-1" title="Thumbnail size ([ / ])">
            <span className="text-[10px] text-neutral-500">Size</span>
            <input
              type="range"
              min={110}
              max={340}
              step={10}
              value={thumbSize}
              onChange={(e) => onThumbSizeChange(Number(e.target.value))}
              className="w-20 accent-amber-400 cursor-pointer"
            />
          </div>
        )}
      </div>

      {/* Right: Workflow Toggles & Batch Actions */}
      <div className="flex items-center gap-1.5 electron-no-drag">
        <button
          type="button"
          onClick={onTogglePairing}
          title="Group matching RAW+JPEG pairs into one item (R)"
          className={`flex items-center gap-1 rounded-md px-2 py-1 border transition ${
            pairingEnabled
              ? 'bg-amber-500/15 border-amber-500/35 text-amber-200'
              : 'bg-white/[0.03] border-white/10 text-neutral-400 hover:text-white'
          }`}
        >
          <Layers className="h-3.5 w-3.5" />
          <span className="hidden xl:inline">RAW+JPG</span>
        </button>

        <button
          type="button"
          onClick={onToggleAutoAdvance}
          title="Auto-advance to next photo after rating (A)"
          className={`flex items-center gap-1 rounded-md px-2 py-1 border transition ${
            autoAdvance
              ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-200'
              : 'bg-white/[0.03] border-white/10 text-neutral-400 hover:text-white'
          }`}
        >
          <FastForward className="h-3.5 w-3.5" />
          <span className="hidden xl:inline">Auto</span>
        </button>

        {viewMode !== 'grid' && (
          <>
            <button
              type="button"
              onClick={onToggleHud}
              title="Toggle HUD / EXIF / Histogram (I)"
              className={`rounded-md p-1.5 border transition ${
                showHud
                  ? 'bg-white/12 border-white/20 text-white'
                  : 'bg-white/[0.03] border-white/10 text-neutral-400 hover:text-white'
              }`}
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onToggleFilmstrip}
              title="Toggle Filmstrip (F)"
              className={`rounded-md p-1.5 border transition ${
                showFilmstrip
                  ? 'bg-white/12 border-white/20 text-white'
                  : 'bg-white/[0.03] border-white/10 text-neutral-400 hover:text-white'
              }`}
            >
              <PanelBottom className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onToggleClipping}
              title="Toggle Highlight/Shadow Clipping Warning (O)"
              className={`rounded-md px-1.5 py-1 text-[10px] font-semibold border transition ${
                showClipping
                  ? 'bg-red-500/20 border-red-500/45 text-red-200'
                  : 'bg-white/[0.03] border-white/10 text-neutral-400 hover:text-white'
              }`}
            >
              CLIP
            </button>
          </>
        )}

        <div className="h-4 w-px bg-white/10 mx-0.5" />

        {folder && (
          <>
            <button
              type="button"
              onClick={() => onOpenBatchModal('export')}
              title="Copy or Move rated keepers to another folder"
              className="flex items-center gap-1 rounded-md bg-white/[0.05] hover:bg-white/10 border border-white/10 px-2 py-1 text-neutral-200 transition"
            >
              <Copy className="h-3.5 w-3.5 text-amber-400" />
              <span className="hidden lg:inline">Keepers</span>
              {ratedCount > 0 && (
                <span className="rounded bg-amber-500/20 px-1 text-[10px] text-amber-300 tabular-nums">
                  {ratedCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => onOpenBatchModal('trash')}
              title="Move unrated or selected photos to Trash"
              className="flex items-center gap-1 rounded-md px-2 py-1 border bg-white/[0.03] hover:bg-white/10 border-white/10 text-neutral-400 hover:text-red-300 transition"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}

        <button
          type="button"
          onClick={onOpenShortcuts}
          title="Keyboard Shortcuts (?)"
          className="rounded-md p-1.5 text-neutral-400 hover:bg-white/[0.08] hover:text-white transition"
        >
          <Keyboard className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}
