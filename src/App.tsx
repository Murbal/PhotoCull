import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Keyboard, Sparkles, Zap } from 'lucide-react';
import type {
  ExifData,
  FilterState,
  PhotoItem,
  PhotoMetadata,
  SortDirection,
  SortField,
  ViewMode,
} from '../shared/types.js';
import {
  fetchExifBatch,
  generateDemoShootApi,
  getHealth,
  isElectronApp,
  patchMetadataApi,
  pickNativeFolder,
  revealInFileManager,
  scanFolderApi,
} from './api/client.js';
import { type DecodedFrame, previewFrameCache } from './engine/imageCache.js';
import type { HistogramData } from './engine/histogram.js';
import { Toolbar } from './components/Toolbar.js';
import { FilterBar } from './components/FilterBar.js';
import { ContactSheet } from './components/ContactSheet.js';
import {
  FIT_VIEWPORT,
  LoupeCanvas,
  type ViewportTransform,
} from './components/LoupeCanvas.js';
import { CompareView } from './components/CompareView.js';
import { InfoHud } from './components/InfoHud.js';
import { Filmstrip } from './components/Filmstrip.js';
import { FolderPickerModal } from './components/FolderPickerModal.js';
import { BatchActionModal, type BatchModalTab } from './components/BatchActionModal.js';
import { ShortcutsModal } from './components/ShortcutsModal.js';

const DEFAULT_FILTER: FilterState = {
  rated: 'all',
  minRating: 0,
  format: 'all',
  search: '',
};

interface UndoEntry {
  itemId: string;
  prev: PhotoMetadata;
}

const RECENT_FOLDERS_KEY = 'photocull.recentFolders.v1';

function loadRecentFolders(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FOLDERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function saveRecentFolder(folder: string): string[] {
  const next = [folder, ...loadRecentFolders().filter((f) => f !== folder)].slice(0, 8);
  try {
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export default function App() {
  const [folder, setFolder] = useState<string>('');
  const [recentFolders, setRecentFolders] = useState<string[]>(() => loadRecentFolders());
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [scanMs, setScanMs] = useState<number | null>(null);
  const [loadingFolder, setLoadingFolder] = useState(false);

  const [pairingEnabled, setPairingEnabled] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [thumbSize, setThumbSize] = useState(200);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [showHud, setShowHud] = useState(true);
  const [showFilmstrip, setShowFilmstrip] = useState(true);
  const [showClipping, setShowClipping] = useState(false);

  const [filter, setFilter] = useState<FilterState>(DEFAULT_FILTER);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');

  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [compareRefId, setCompareRefId] = useState<string | null>(null);

  const [viewport, setViewport] = useState<ViewportTransform>(FIT_VIEWPORT);
  const [histogram, setHistogram] = useState<HistogramData | null>(null);
  const [lastDecodeMs, setLastDecodeMs] = useState<number | null>(null);

  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [batchModalTab, setBatchModalTab] = useState<BatchModalTab | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone?: 'info' | 'error' } | null>(null);
  const [generatingDemo, setGeneratingDemo] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const undoStackRef = useRef<UndoEntry[]>([]);
  const toastTimerRef = useRef<number | null>(null);
  const exifRequestedRef = useRef<Set<string>>(new Set());
  const lastClickedIdxRef = useRef<number>(0);

  const showToast = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    setToast({ text, tone });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  // Load a folder directly from disk (no catalog/import)
  const openFolder = useCallback(
    async (dirPath: string, pairing = pairingEnabled, preserveItemId?: string) => {
      if (!dirPath.trim()) return;
      setLoadingFolder(true);
      try {
        const res = await scanFolderApi(dirPath, pairing);
        previewFrameCache.clear();
        exifRequestedRef.current.clear();

        setFolder(res.folder);
        setItems(res.items);
        setScanMs(res.scanMs);
        setRecentFolders(saveRecentFolder(res.folder));
        setViewport(FIT_VIEWPORT);

        if (preserveItemId) {
          const nextIdx = res.items.findIndex((it) => it.id === preserveItemId);
          setActiveIndex(nextIdx >= 0 ? nextIdx : 0);
        } else {
          setActiveIndex(0);
          setSelectedIds(res.items[0] ? new Set([res.items[0].id]) : new Set());
          setCompareRefId(null);
        }

        if (res.items.length === 0) {
          showToast(`Opened ${res.folder} (0 supported RAW/image files found)`);
        } else {
          showToast(`Opened ${res.items.length} frames in ${res.scanMs}ms`);
        }
      } catch (err: unknown) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        setLoadingFolder(false);
      }
    },
    [pairingEnabled, showToast],
  );

  // Check if CLI launched with an initial folder
  useEffect(() => {
    getHealth()
      .then((h) => {
        if (h.initialFolder) {
          void openFolder(h.initialFolder, true);
        }
      })
      .catch(() => {
        // ignore
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute filtered & sorted list
  const filteredItems = useMemo(() => {
    const q = filter.search.trim().toLowerCase();
    const list = items.filter((item) => {
      if (filter.rated === 'rated' && item.metadata.rating === 0) return false;
      if (filter.rated === 'unrated' && item.metadata.rating > 0) return false;
      if (filter.minRating > 0 && item.metadata.rating < filter.minRating) return false;
      if (filter.format === 'raw' && item.kind !== 'raw' && item.kind !== 'raw+jpeg') return false;
      if (filter.format === 'jpeg' && item.kind !== 'image') return false;
      if (filter.format === 'paired' && item.kind !== 'raw+jpeg') return false;
      if (q && !item.displayName.toLowerCase().includes(q)) return false;
      return true;
    });

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const dirMul = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (sortField === 'name') return collator.compare(a.displayName, b.displayName) * dirMul;
      if (sortField === 'rating') {
        const diff = (a.metadata.rating - b.metadata.rating) * dirMul;
        return diff !== 0 ? diff : collator.compare(a.displayName, b.displayName);
      }
      if (sortField === 'size') return (a.sizeBytes - b.sizeBytes) * dirMul;
      const da = a.exif?.dateTimeOriginal || '';
      const db = b.exif?.dateTimeOriginal || '';
      if (da && db && da !== db) return da.localeCompare(db) * dirMul;
      return (a.mtimeMs - b.mtimeMs) * dirMul;
    });

    return list;
  }, [items, filter, sortField, sortDir]);

  useEffect(() => {
    if (filteredItems.length === 0) {
      setActiveIndex(0);
    } else if (activeIndex >= filteredItems.length) {
      setActiveIndex(filteredItems.length - 1);
    }
  }, [filteredItems.length, activeIndex]);

  const activeItem: PhotoItem | null = filteredItems[activeIndex] ?? null;

  const compareRefItem: PhotoItem | null = useMemo(() => {
    if (!compareRefId) return filteredItems[Math.max(0, activeIndex - 1)] ?? activeItem;
    return items.find((it) => it.id === compareRefId) ?? activeItem;
  }, [compareRefId, items, filteredItems, activeIndex, activeItem]);

  // Aggregate counts for filter bar & toolbar
  const counts = useMemo(() => {
    let rated = 0;
    let unrated = 0;
    for (const it of items) {
      if (it.metadata.rating > 0) rated++;
      else unrated++;
    }
    return {
      total: items.length,
      filtered: filteredItems.length,
      rated,
      unrated,
    };
  }, [items, filteredItems.length]);

  // Directional multi-frame background prefetching whenever cursor moves
  useEffect(() => {
    if (!folder || filteredItems.length === 0) return;
    const ahead = viewMode === 'grid' ? 3 : 8;
    const behind = viewMode === 'grid' ? 1 : 4;
    previewFrameCache.prefetchWindow(folder, filteredItems, activeIndex, ahead, behind);
  }, [folder, filteredItems, activeIndex, viewMode]);

  // Hydrate EXIF metadata for active frame + neighboring window in a single batch call
  useEffect(() => {
    if (!folder || filteredItems.length === 0) return;
    const start = Math.max(0, activeIndex - 4);
    const end = Math.min(filteredItems.length, activeIndex + 12);
    const needExif: string[] = [];
    for (let i = start; i < end; i++) {
      const it = filteredItems[i];
      if (!it.exif && !exifRequestedRef.current.has(it.primaryFile)) {
        exifRequestedRef.current.add(it.primaryFile);
        needExif.push(it.primaryFile);
      }
    }
    if (needExif.length === 0) return;

    fetchExifBatch(folder, needExif)
      .then((res) => {
        const map = res.exif as Record<string, ExifData>;
        if (!map || Object.keys(map).length === 0) return;
        setItems((prev) =>
          prev.map((it) => (map[it.primaryFile] ? { ...it, exif: map[it.primaryFile] } : it)),
        );
      })
      .catch(() => {
        // ignore transient EXIF errors
      });
  }, [folder, filteredItems, activeIndex]);

  // Optimistic star rating update + atomic XMP sidecar write (`xmp:Rating`)
  const updateItemRating = useCallback(
    (
      target: PhotoItem,
      rating: number,
      options: { allowAutoAdvance?: boolean; recordUndo?: boolean } = {},
    ) => {
      const { allowAutoAdvance = true, recordUndo = true } = options;
      const clamped = Math.max(0, Math.min(5, Math.round(rating)));
      const prevMeta = target.metadata;
      const nextMeta: PhotoMetadata = {
        rating: clamped,
        hasXmp: true,
      };

      if (recordUndo) {
        undoStackRef.current.push({ itemId: target.id, prev: prevMeta });
        if (undoStackRef.current.length > 100) undoStackRef.current.shift();
      }

      setItems((prev) =>
        prev.map((it) => (it.id === target.id ? { ...it, metadata: nextMeta } : it)),
      );

      patchMetadataApi({
        folder,
        itemId: target.id,
        rating: clamped,
        pairingEnabled,
      }).catch((err: unknown) => {
        showToast(`Failed to save XMP: ${err instanceof Error ? err.message : String(err)}`, 'error');
        setItems((prev) =>
          prev.map((it) => (it.id === target.id ? { ...it, metadata: prevMeta } : it)),
        );
      });

      if (allowAutoAdvance && autoAdvance && activeIndex < filteredItems.length - 1) {
        setActiveIndex((i) => Math.min(filteredItems.length - 1, i + 1));
      }
    },
    [folder, pairingEnabled, autoAdvance, activeIndex, filteredItems.length, showToast],
  );

  const handleUndo = useCallback(() => {
    const last = undoStackRef.current.pop();
    if (!last) {
      showToast('Nothing to undo');
      return;
    }
    const item = items.find((it) => it.id === last.itemId);
    if (!item) return;
    updateItemRating(item, last.prev.rating, { allowAutoAdvance: false, recordUndo: false });
    showToast(`Undid rating on ${item.displayName}`);
  }, [items, updateItemRating, showToast]);

  const handleSelectGridCard = useCallback(
    (index: number, e: React.MouseEvent) => {
      const target = filteredItems[index];
      if (!target) return;
      setActiveIndex(index);

      if (e.shiftKey) {
        const from = Math.min(lastClickedIdxRef.current, index);
        const to = Math.max(lastClickedIdxRef.current, index);
        const next = new Set(selectedIds);
        for (let i = from; i <= to; i++) {
          if (filteredItems[i]) next.add(filteredItems[i].id);
        }
        setSelectedIds(next);
      } else if (e.metaKey || e.ctrlKey) {
        const next = new Set(selectedIds);
        if (next.has(target.id)) next.delete(target.id);
        else next.add(target.id);
        setSelectedIds(next);
        lastClickedIdxRef.current = index;
      } else {
        setSelectedIds(new Set([target.id]));
        lastClickedIdxRef.current = index;
      }
    },
    [filteredItems, selectedIds],
  );

  const handleChangeView = useCallback(
    (nextMode: ViewMode) => {
      if (nextMode === 'compare' && filteredItems.length >= 2) {
        const current = filteredItems[activeIndex];
        if (current && !compareRefId) {
          setCompareRefId(current.id);
          if (activeIndex + 1 < filteredItems.length) {
            setActiveIndex(activeIndex + 1);
          }
        }
      }
      setViewport(FIT_VIEWPORT);
      setViewMode(nextMode);
    },
    [filteredItems, activeIndex, compareRefId],
  );

  const handleSwapCompare = useCallback(() => {
    if (!compareRefItem || !activeItem) return;
    const prevRefId = compareRefItem.id;
    const nextRefIdx = filteredItems.findIndex((it) => it.id === prevRefId);
    setCompareRefId(activeItem.id);
    if (nextRefIdx >= 0) setActiveIndex(nextRefIdx);
  }, [compareRefItem, activeItem, filteredItems]);

  const handlePromoteCandidate = useCallback(() => {
    if (!activeItem) return;
    setCompareRefId(activeItem.id);
    showToast(`Pinned ${activeItem.displayName} as Select`);
  }, [activeItem, showToast]);

  const handleTogglePairing = useCallback(() => {
    const next = !pairingEnabled;
    setPairingEnabled(next);
    if (folder) {
      void openFolder(folder, next, activeItem?.id);
    }
  }, [pairingEnabled, folder, openFolder, activeItem?.id]);

  const handleFrameLoaded = useCallback((f: DecodedFrame | null) => {
    setLastDecodeMs(f ? f.decodeMs : null);
  }, []);

  const handleQuickDemo = useCallback(async () => {
    setGeneratingDemo(true);
    try {
      const res = await generateDemoShootApi(24);
      await openFolder(res.folder, pairingEnabled);
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setGeneratingDemo(false);
    }
  }, [openFolder, pairingEnabled, showToast]);

  const handleOpenFolderTrigger = useCallback(async () => {
    if (isElectronApp()) {
      const picked = await pickNativeFolder({
        title: 'Open Photo Folder',
        defaultPath: folder || undefined,
      });
      if (picked) {
        void openFolder(picked, pairingEnabled);
      }
      return;
    }
    setShowFolderPicker(true);
  }, [folder, openFolder, pairingEnabled]);

  const handleRevealCurrent = useCallback(() => {
    if (!folder || !activeItem) return;
    void revealInFileManager(folder, activeItem.primaryFile);
  }, [folder, activeItem]);

  // Keep native Electron window title updated with current folder & frame
  useEffect(() => {
    if (!folder) {
      document.title = 'PhotoCull — Ultra-Fast RAW Photo Culling';
      return;
    }
    const shortFolder = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
    document.title =
      viewMode !== 'grid' && activeItem
        ? `${activeItem.displayName} — ${shortFolder} · PhotoCull`
        : `${shortFolder} (${filteredItems.length}) · PhotoCull`;
  }, [folder, viewMode, activeItem, filteredItems.length]);

  // Subscribe to native Electron application menu actions
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    return api.onMenuAction(({ action, payload }) => {
      if (action === 'open-folder') void handleOpenFolderTrigger();
      else if (action === 'open-specific-folder' && typeof payload === 'string') {
        void api.resolveDroppedFolder(payload).then((dir) => openFolder(dir, pairingEnabled));
      } else if (action === 'reveal-current') handleRevealCurrent();
      else if (action === 'generate-demo') void handleQuickDemo();
      else if (action === 'view-grid') handleChangeView('grid');
      else if (action === 'view-loupe') handleChangeView('loupe');
      else if (action === 'view-compare') handleChangeView('compare');
      else if (action === 'batch-export' && folder) setBatchModalTab('export');
      else if (action === 'batch-trash' && folder) setBatchModalTab('trash');
      else if (action === 'batch-ingest' && folder) setBatchModalTab('ingest');
      else if (action === 'show-shortcuts') setShowShortcuts((v) => !v);
    });
  }, [
    folder,
    pairingEnabled,
    handleOpenFolderTrigger,
    handleRevealCurrent,
    handleQuickDemo,
    handleChangeView,
    openFolder,
  ]);

  // Drag & Drop a folder (or photo file) straight onto the Electron desktop window
  const handleDropFolder = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      const api = window.electronAPI;
      if (!api) return;
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      const droppedPath = api.getPathForFile(file);
      if (!droppedPath) return;
      try {
        const targetDir = await api.resolveDroppedFolder(droppedPath);
        await openFolder(targetDir, pairingEnabled);
      } catch (err: unknown) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    [openFolder, pairingEnabled, showToast],
  );

  // Global keyboard-first culling loop (navigation, 0-5 star ratings, zoom, views)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Escape') {
        if (showShortcuts) return setShowShortcuts(false);
        if (batchModalTab) return setBatchModalTab(null);
        if (showFolderPicker) return setShowFolderPicker(false);
        if (viewport.zoomMode !== 'fit') {
          setViewport(FIT_VIEWPORT);
          return;
        }
        if (viewMode !== 'grid') {
          setViewMode('grid');
          return;
        }
        return;
      }

      if (showFolderPicker || batchModalTab) return;

      if (e.key === '?') {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }

      if (showShortcuts) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelectedIds(new Set(filteredItems.map((it) => it.id)));
        showToast(`Selected all ${filteredItems.length} visible photos`);
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const key = e.key;
      const lower = key.toLowerCase();

      const stepBy = (delta: number) => {
        if (filteredItems.length === 0) return;
        const nextIdx = Math.max(0, Math.min(filteredItems.length - 1, activeIndex + delta));
        if (nextIdx !== activeIndex) {
          setActiveIndex(nextIdx);
          setSelectedIds(new Set([filteredItems[nextIdx].id]));
          lastClickedIdxRef.current = nextIdx;
        }
      };

      if (key === 'ArrowRight' || lower === 'k' || lower === 'l') {
        e.preventDefault();
        stepBy(1);
        return;
      }
      if (key === 'ArrowLeft' || lower === 'j' || lower === 'h') {
        e.preventDefault();
        stepBy(-1);
        return;
      }
      if (viewMode === 'grid' && (key === 'ArrowDown' || key === 'ArrowUp')) {
        e.preventDefault();
        const gridEl = document.querySelector('[data-grid-columns]');
        const cols = Number(gridEl?.getAttribute('data-grid-columns') || '4') || 4;
        stepBy(key === 'ArrowDown' ? cols : -cols);
        return;
      }
      if (key === 'Home') {
        e.preventDefault();
        if (filteredItems.length > 0) {
          setActiveIndex(0);
          setSelectedIds(new Set([filteredItems[0].id]));
        }
        return;
      }
      if (key === 'End') {
        e.preventDefault();
        if (filteredItems.length > 0) {
          const last = filteredItems.length - 1;
          setActiveIndex(last);
          setSelectedIds(new Set([filteredItems[last].id]));
        }
        return;
      }

      // View toggles
      if (lower === 'g') {
        e.preventDefault();
        handleChangeView(viewMode === 'grid' ? 'loupe' : 'grid');
        return;
      }
      if (key === 'Enter' && viewMode === 'grid' && activeItem) {
        e.preventDefault();
        handleChangeView('loupe');
        return;
      }
      if (lower === 'c') {
        e.preventDefault();
        handleChangeView(viewMode === 'compare' ? 'loupe' : 'compare');
        return;
      }
      if (lower === 's' && viewMode === 'compare') {
        e.preventDefault();
        handleSwapCompare();
        return;
      }

      // Zoom (Space or Z -> 100% centered on AF focus point when available, Shift+Z -> 200%)
      if (lower === 'z' || key === ' ') {
        if (viewMode === 'grid' && key === ' ') {
          e.preventDefault();
          handleChangeView('loupe');
          return;
        }
        if (viewMode !== 'grid') {
          e.preventDefault();
          if (e.shiftKey && lower === 'z') {
            setViewport((v) =>
              v.zoomMode === '200'
                ? FIT_VIEWPORT
                : {
                    zoomMode: '200',
                    scale: 2,
                    panX: v.panX,
                    panY: v.panY,
                    ...(v.zoomMode === 'fit' || v.followFocus ? { followFocus: true } : {}),
                  },
            );
          } else {
            setViewport((v) =>
              v.zoomMode === 'fit'
                ? {
                    zoomMode: '100',
                    scale: 1,
                    panX: 0,
                    panY: 0,
                    followFocus: true,
                  }
                : FIT_VIEWPORT,
            );
          }
          return;
        }
      }

      if (lower === 'i') {
        e.preventDefault();
        setShowHud((v) => !v);
        return;
      }
      if (lower === 'f') {
        e.preventDefault();
        setShowFilmstrip((v) => !v);
        return;
      }
      if (lower === 'o') {
        e.preventDefault();
        setShowClipping((v) => !v);
        return;
      }
      if (lower === 'a') {
        e.preventDefault();
        setAutoAdvance((v) => {
          showToast(`Auto-Advance ${!v ? 'ON' : 'OFF'}`);
          return !v;
        });
        return;
      }
      if (lower === 'r') {
        e.preventDefault();
        handleTogglePairing();
        return;
      }
      if (key === '[' && viewMode === 'grid') {
        e.preventDefault();
        setThumbSize((s) => Math.max(110, s - 20));
        return;
      }
      if (key === ']' && viewMode === 'grid') {
        e.preventDefault();
        setThumbSize((s) => Math.min(340, s + 20));
        return;
      }

      // Star ratings 0..5
      if (activeItem && key >= '0' && key <= '5') {
        e.preventDefault();
        updateItemRating(activeItem, Number(key));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    folder,
    showShortcuts,
    batchModalTab,
    showFolderPicker,
    viewport.zoomMode,
    viewMode,
    filteredItems,
    activeIndex,
    activeItem,
    handleUndo,
    handleChangeView,
    handleSwapCompare,
    handleTogglePairing,
    updateItemRating,
    showToast,
  ]);

  return (
    <div
      onDragOver={(e) => {
        if (isElectronApp()) {
          e.preventDefault();
          setIsDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setIsDragOver(false);
      }}
      onDrop={(e) => void handleDropFolder(e)}
      className="h-screen w-screen flex flex-col bg-[#0d0d0f] text-neutral-200 overflow-hidden relative"
    >
      {isDragOver && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs border-2 border-dashed border-amber-400/80 m-3 rounded-2xl">
          <div className="flex flex-col items-center gap-2 text-amber-200">
            <FolderOpen className="h-10 w-10 text-amber-400" />
            <span className="text-base font-semibold">Drop folder or RAW file to open shoot</span>
          </div>
        </div>
      )}

      <Toolbar
        folder={folder}
        hasActiveItem={Boolean(activeItem)}
        scanMs={scanMs}
        viewMode={viewMode}
        pairingEnabled={pairingEnabled}
        autoAdvance={autoAdvance}
        showHud={showHud}
        showFilmstrip={showFilmstrip}
        showClipping={showClipping}
        thumbSize={thumbSize}
        ratedCount={counts.rated}
        onOpenFolder={() => void handleOpenFolderTrigger()}
        onRevealCurrent={handleRevealCurrent}
        onRefresh={() => folder && void openFolder(folder, pairingEnabled, activeItem?.id)}
        onChangeView={handleChangeView}
        onTogglePairing={handleTogglePairing}
        onToggleAutoAdvance={() => setAutoAdvance((v) => !v)}
        onToggleHud={() => setShowHud((v) => !v)}
        onToggleFilmstrip={() => setShowFilmstrip((v) => !v)}
        onToggleClipping={() => setShowClipping((v) => !v)}
        onThumbSizeChange={setThumbSize}
        onOpenBatchModal={(tab) => setBatchModalTab(tab)}
        onOpenShortcuts={() => setShowShortcuts(true)}
      />

      {folder && (
        <FilterBar
          filter={filter}
          sortField={sortField}
          sortDir={sortDir}
          counts={counts}
          onFilterChange={setFilter}
          onSortChange={(f, d) => {
            setSortField(f);
            setSortDir(d);
          }}
          onResetFilters={() => setFilter(DEFAULT_FILTER)}
        />
      )}

      {/* Main Viewport */}
      <main className="flex-1 flex flex-col min-h-0 relative overflow-hidden">
        {!folder ? (
          <div className="flex-1 flex items-center justify-center p-6 bg-[radial-gradient(ellipse_at_top,_rgba(245,158,11,0.08),_transparent_55%)]">
            <div className="max-w-xl w-full space-y-6 text-center">
              <div className="inline-flex items-center gap-2 rounded-full bg-amber-500/10 border border-amber-500/25 px-3 py-1 text-xs text-amber-300">
                <Zap className="h-3.5 w-3.5" />
                Zero-Catalog · Native RAW Preview Extraction · Standard xmp:Rating Sidecars
              </div>

              <div className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tight text-white">
                  Ultra-Fast RAW Photo Culling
                </h1>
                <p className="text-sm text-neutral-400 leading-relaxed">
                  Open any folder of Sony <code className="text-neutral-200">.ARW</code>, Canon{' '}
                  <code className="text-neutral-200">.CR3/.CR2</code>, Nikon{' '}
                  <code className="text-neutral-200">.NEF</code>, Fujifilm{' '}
                  <code className="text-neutral-200">.RAF</code>, <code className="text-neutral-200">.DNG</code>,{' '}
                  <code className="text-neutral-200">.ORF</code>, <code className="text-neutral-200">.RW2</code>, or
                  JPEG files directly. Flip frames with zero lag, check 100% sharpness, rate 1–5 stars, and sync
                  standard <code className="text-amber-300">.xmp</code> sidecars with Lightroom, Capture One, and
                  Darktable.
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => void handleOpenFolderTrigger()}
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-semibold px-5 py-2.5 text-sm shadow-lg shadow-amber-500/15 transition"
                >
                  <FolderOpen className="h-4 w-4" />
                  Open Photo Folder
                </button>
                <button
                  type="button"
                  disabled={generatingDemo}
                  onClick={() => void handleQuickDemo()}
                  className="inline-flex items-center gap-2 rounded-lg bg-white/[0.06] hover:bg-white/12 border border-white/12 text-neutral-100 font-medium px-4 py-2.5 text-sm transition disabled:opacity-50"
                >
                  <Sparkles className="h-4 w-4 text-amber-400" />
                  {generatingDemo ? 'Generating Demo RAWs…' : 'Try Demo RAW Shoot (24 frames)'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowShortcuts(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-transparent hover:bg-white/[0.06] border border-white/10 text-neutral-300 px-3.5 py-2.5 text-sm transition"
                >
                  <Keyboard className="h-4 w-4" />
                  Shortcuts
                </button>
              </div>

              {recentFolders.length > 0 && (
                <div className="pt-4 border-t border-white/[0.07] text-left">
                  <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">
                    Recent Folders
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {recentFolders.map((rf) => (
                      <button
                        key={rf}
                        type="button"
                        onClick={() => void openFolder(rf, pairingEnabled)}
                        className="flex items-center gap-2 rounded-md bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.06] px-3 py-2 text-xs text-neutral-300 text-left transition"
                      >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
                        <span className="truncate font-mono">{rf}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : loadingFolder ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-neutral-400 text-xs">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-neutral-700 border-t-amber-400" />
            <span>Scanning filesystem & reading .xmp sidecars…</span>
          </div>
        ) : viewMode === 'grid' ? (
          <ContactSheet
            folder={folder}
            items={filteredItems}
            activeIndex={activeIndex}
            selectedIds={selectedIds}
            thumbSize={thumbSize}
            onSelect={handleSelectGridCard}
            onOpenLoupe={(idx) => {
              setActiveIndex(idx);
              handleChangeView('loupe');
            }}
            onRate={(it, rating) => updateItemRating(it, rating, { allowAutoAdvance: false })}
          />
        ) : viewMode === 'compare' ? (
          <>
            <CompareView
              folder={folder}
              refItem={compareRefItem}
              candItem={activeItem}
              viewport={viewport}
              onViewportChange={setViewport}
              showClipping={showClipping}
              onSwap={handleSwapCompare}
              onPromoteCandidate={handlePromoteCandidate}
              onRate={(it, rating) => updateItemRating(it, rating, { allowAutoAdvance: false })}
            />
            {showFilmstrip && (
              <Filmstrip
                folder={folder}
                items={filteredItems}
                activeIndex={activeIndex}
                onSelect={(idx) => {
                  setActiveIndex(idx);
                  setSelectedIds(new Set([filteredItems[idx].id]));
                }}
              />
            )}
          </>
        ) : (
          /* Single-Image Loupe View */
          <>
            <div className="flex-1 min-h-0 relative">
              <LoupeCanvas
                folder={folder}
                item={activeItem}
                viewport={viewport}
                onViewportChange={setViewport}
                showClipping={showClipping}
                onHistogram={setHistogram}
                onFrameLoaded={handleFrameLoaded}
              />

              {showHud && activeItem && (
                <InfoHud
                  item={activeItem}
                  index={activeIndex}
                  total={filteredItems.length}
                  histogram={histogram}
                  clippingActive={showClipping}
                  decodeMs={lastDecodeMs}
                  onRate={(rating) => updateItemRating(activeItem, rating)}
                  onToggleClipping={() => setShowClipping((v) => !v)}
                />
              )}
            </div>

            {showFilmstrip && (
              <Filmstrip
                folder={folder}
                items={filteredItems}
                activeIndex={activeIndex}
                onSelect={(idx) => {
                  setActiveIndex(idx);
                  setSelectedIds(new Set([filteredItems[idx].id]));
                }}
              />
            )}
          </>
        )}

        {/* Toast Notification */}
        {toast && (
          <div className="pointer-events-none fixed bottom-6 right-5 z-50">
            <div
              className={`rounded-lg px-3.5 py-2 text-xs font-medium shadow-2xl border backdrop-blur-md ${
                toast.tone === 'error'
                  ? 'bg-red-950/90 border-red-500/40 text-red-100'
                  : 'bg-[#18181f]/95 border-white/15 text-neutral-100'
              }`}
            >
              {toast.text}
            </div>
          </div>
        )}
      </main>

      {/* Modals */}
      {showFolderPicker && (
        <FolderPickerModal
          initialDir={folder || undefined}
          recentFolders={recentFolders}
          onSelectFolder={(chosen) => {
            setShowFolderPicker(false);
            void openFolder(chosen, pairingEnabled);
          }}
          onClose={() => setShowFolderPicker(false)}
        />
      )}

      {batchModalTab && folder && (
        <BatchActionModal
          initialTab={batchModalTab}
          folder={folder}
          allItems={items}
          filteredItems={filteredItems}
          selectedIds={selectedIds}
          pairingEnabled={pairingEnabled}
          onCompleted={(msg, reloadFolder) => {
            showToast(msg);
            void openFolder(reloadFolder || folder, pairingEnabled);
          }}
          onClose={() => setBatchModalTab(null)}
        />
      )}

      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
    </div>
  );
}
