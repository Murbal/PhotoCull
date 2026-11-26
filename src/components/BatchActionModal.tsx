import { useState } from 'react';
import { Copy, Download, FolderInput, FolderOpen, Trash2, X } from 'lucide-react';
import type { BatchActionResult, IngestResult, PhotoItem } from '../../shared/types.js';
import { isElectronApp, pickNativeFolder, runBatchActionApi, runIngestApi } from '../api/client.js';
import { FolderPickerModal } from './FolderPickerModal.js';
import { formatBytes } from './MetadataBadges.js';

export type BatchModalTab = 'export' | 'trash' | 'ingest';

interface BatchActionModalProps {
  initialTab: BatchModalTab;
  folder: string;
  allItems: PhotoItem[];
  filteredItems: PhotoItem[];
  selectedIds: Set<string>;
  pairingEnabled: boolean;
  onCompleted: (message: string, reloadFolder?: string) => void;
  onClose: () => void;
}

export function BatchActionModal({
  initialTab,
  folder,
  allItems,
  filteredItems,
  selectedIds,
  pairingEnabled,
  onCompleted,
  onClose,
}: BatchActionModalProps) {
  const [tab, setTab] = useState<BatchModalTab>(initialTab);

  // Export (Copy/Move) state
  const [scope, setScope] = useState<'rated1' | 'rated3' | 'rated4' | 'filtered' | 'selected'>('rated3');
  const [exportOp, setExportOp] = useState<'copy' | 'move'>('copy');
  const [targetFolder, setTargetFolder] = useState(`${folder}/Selects`);
  const [conflictStrategy, setConflictStrategy] = useState<'rename' | 'skip' | 'overwrite'>('rename');

  // Trash state
  const [trashScope, setTrashScope] = useState<'unrated' | 'lowRated' | 'selected'>('unrated');

  // Ingest state
  const [ingestSource, setIngestSource] = useState('');
  const [ingestTargetRoot, setIngestTargetRoot] = useState(folder);
  const [ingestTemplate, setIngestTemplate] = useState('{YYYY}-{MM}-{DD}_{name}');
  const [ingestName, setIngestName] = useState('Shoot');
  const [includeSidecars, setIncludeSidecars] = useState(true);

  const [browsingFor, setBrowsingFor] = useState<'exportTarget' | 'ingestSource' | 'ingestRoot' | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBrowseFolder = async (which: 'exportTarget' | 'ingestSource' | 'ingestRoot') => {
    if (isElectronApp()) {
      const title =
        which === 'exportTarget'
          ? 'Select Destination Folder'
          : which === 'ingestSource'
            ? 'Select Source / SD Card Folder'
            : 'Select Ingest Root Folder';
      const defaultPath =
        which === 'exportTarget'
          ? folder
          : which === 'ingestRoot'
            ? ingestTargetRoot
            : undefined;
      const chosen = await pickNativeFolder({ title, defaultPath });
      if (chosen) {
        if (which === 'exportTarget') setTargetFolder(chosen);
        else if (which === 'ingestSource') setIngestSource(chosen);
        else setIngestTargetRoot(chosen);
      }
      return;
    }
    setBrowsingFor(which);
  };

  const rated1Items = allItems.filter((it) => it.metadata.rating >= 1);
  const rated3Items = allItems.filter((it) => it.metadata.rating >= 3);
  const rated4Items = allItems.filter((it) => it.metadata.rating >= 4);
  const unratedItems = allItems.filter((it) => it.metadata.rating === 0);
  const lowRatedItems = allItems.filter((it) => it.metadata.rating <= 1);
  const selectedItems = allItems.filter((it) => selectedIds.has(it.id));

  const exportItems =
    scope === 'rated1'
      ? rated1Items
      : scope === 'rated3'
        ? rated3Items
        : scope === 'rated4'
          ? rated4Items
          : scope === 'selected'
            ? selectedItems
            : filteredItems;

  const trashItems =
    trashScope === 'unrated'
      ? unratedItems
      : trashScope === 'lowRated'
        ? lowRatedItems
        : selectedItems;

  const countPhysicalFiles = (items: PhotoItem[]) =>
    items.reduce(
      (acc, it) => acc + (it.rawFile ? 1 : 0) + (it.jpegFile ? 1 : 0) + (it.metadata.hasXmp ? 1 : 0),
      0,
    );

  const handleRunExport = async () => {
    if (exportItems.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      const res: BatchActionResult = await runBatchActionApi({
        folder,
        itemIds: exportItems.map((it) => it.id),
        action: exportOp,
        targetFolder,
        pairingEnabled,
        conflictStrategy,
      });
      const verb = exportOp === 'copy' ? 'Copied' : 'Moved';
      onCompleted(
        `${verb} ${res.processedItems} item(s) (${res.processedFiles} files incl. paired/XMP) → ${targetFolder}`,
      );
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const handleRunTrash = async () => {
    if (trashItems.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      const res: BatchActionResult = await runBatchActionApi({
        folder,
        itemIds: trashItems.map((it) => it.id),
        action: 'trash',
        pairingEnabled,
      });
      onCompleted(
        `Moved ${res.processedItems} item(s) (${res.processedFiles} files) to Trash${res.trashDir ? ` (${res.trashDir})` : ''}`,
      );
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const handleRunIngest = async () => {
    if (!ingestSource.trim() || !ingestTargetRoot.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const res: IngestResult = await runIngestApi({
        sourceFolder: ingestSource,
        targetRoot: ingestTargetRoot,
        template: ingestTemplate,
        shootName: ingestName,
        includeSidecars,
      });
      onCompleted(
        `Ingested ${res.copiedFiles} files (${formatBytes(res.totalBytes)}) → ${res.destinationFolder}`,
        res.destinationFolder,
      );
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
        onClick={onClose}
      >
        <div
          className="w-full max-w-xl rounded-xl bg-[#151519] border border-white/12 shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Tabs header */}
          <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-white/[0.08]">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setTab('export')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  tab === 'export'
                    ? 'bg-amber-500/15 text-amber-200 border border-amber-500/35'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy / Move Keepers
              </button>
              <button
                type="button"
                onClick={() => setTab('trash')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  tab === 'trash'
                    ? 'bg-red-500/15 text-red-200 border border-red-500/35'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Trash Photos
              </button>
              <button
                type="button"
                onClick={() => setTab('ingest')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  tab === 'ingest'
                    ? 'bg-sky-500/15 text-sky-200 border border-sky-500/35'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                <Download className="h-3.5 w-3.5" />
                Ingest SD Card
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-white transition"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="p-4 space-y-4 text-xs">
            {error && (
              <div className="rounded-md bg-red-500/15 border border-red-500/35 px-3 py-2 text-red-200">
                {error}
              </div>
            )}

            {tab === 'export' && (
              <>
                <div className="space-y-1.5">
                  <label className="text-neutral-400 font-medium">Photos to include (RAW + paired JPG + .xmp stay synced)</label>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { id: 'rated4' as const, label: `Rated ≥ 4★ (${rated4Items.length})` },
                      { id: 'rated3' as const, label: `Rated ≥ 3★ (${rated3Items.length})` },
                      { id: 'rated1' as const, label: `All Rated ≥ 1★ (${rated1Items.length})` },
                      { id: 'filtered' as const, label: `Current Filter (${filteredItems.length})` },
                      { id: 'selected' as const, label: `Selected (${selectedItems.length})` },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setScope(opt.id)}
                        className={`rounded-md px-3 py-2 text-left border transition ${
                          scope === opt.id
                            ? 'bg-amber-500/15 border-amber-500/45 text-amber-100'
                            : 'bg-[#101014] border-white/10 text-neutral-300 hover:border-white/20'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-neutral-400 font-medium">Action</label>
                    <div className="flex rounded-md overflow-hidden border border-white/10">
                      <button
                        type="button"
                        onClick={() => setExportOp('copy')}
                        className={`flex-1 py-1.5 flex items-center justify-center gap-1.5 transition ${
                          exportOp === 'copy' ? 'bg-amber-500 text-black font-semibold' : 'bg-[#101014] text-neutral-300'
                        }`}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        Copy
                      </button>
                      <button
                        type="button"
                        onClick={() => setExportOp('move')}
                        className={`flex-1 py-1.5 flex items-center justify-center gap-1.5 transition ${
                          exportOp === 'move' ? 'bg-amber-500 text-black font-semibold' : 'bg-[#101014] text-neutral-300'
                        }`}
                      >
                        <FolderInput className="h-3.5 w-3.5" />
                        Move
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-neutral-400 font-medium">If file exists</label>
                    <select
                      value={conflictStrategy}
                      onChange={(e) => setConflictStrategy(e.target.value as 'rename' | 'skip' | 'overwrite')}
                      className="w-full rounded-md bg-[#101014] border border-white/10 px-2.5 py-1.5 text-neutral-200 focus:outline-none focus:border-amber-400"
                    >
                      <option value="rename">Auto-rename (_1, _2)</option>
                      <option value="skip">Skip existing</option>
                      <option value="overwrite">Overwrite</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-neutral-400 font-medium">Destination Folder</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={targetFolder}
                      onChange={(e) => setTargetFolder(e.target.value)}
                      className="flex-1 rounded-md bg-[#0b0b0e] border border-white/10 px-3 py-1.5 font-mono text-neutral-200 focus:outline-none focus:border-amber-400"
                    />
                    <button
                      type="button"
                      onClick={() => void handleBrowseFolder('exportTarget')}
                      className="rounded-md bg-white/[0.07] hover:bg-white/12 px-2.5 py-1.5 text-neutral-200 flex items-center gap-1"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      Browse
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-white/[0.08]">
                  <span className="text-neutral-400 tabular-nums">
                    {exportItems.length} item(s) · ~{countPhysicalFiles(exportItems)} file(s)
                  </span>
                  <div className="flex gap-2">
                    <button type="button" onClick={onClose} className="px-3 py-1.5 text-neutral-400 hover:text-white">
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={running || exportItems.length === 0 || !targetFolder.trim()}
                      onClick={() => void handleRunExport()}
                      className="rounded-md bg-amber-500 hover:bg-amber-400 text-black font-semibold px-4 py-1.5 transition disabled:opacity-40"
                    >
                      {running ? 'Processing…' : `${exportOp === 'copy' ? 'Copy' : 'Move'} ${exportItems.length} Photo(s)`}
                    </button>
                  </div>
                </div>
              </>
            )}

            {tab === 'trash' && (
              <>
                <div className="space-y-2">
                  <label className="text-neutral-400 font-medium">Safe Move-to-Trash (never permanently deletes directly)</label>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => setTrashScope('unrated')}
                      className={`rounded-md px-3 py-2 text-left border transition ${
                        trashScope === 'unrated'
                          ? 'bg-red-500/15 border-red-500/45 text-red-100'
                          : 'bg-[#101014] border-white/10 text-neutral-300'
                      }`}
                    >
                      Unrated 0★ ({unratedItems.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setTrashScope('lowRated')}
                      className={`rounded-md px-3 py-2 text-left border transition ${
                        trashScope === 'lowRated'
                          ? 'bg-red-500/15 border-red-500/45 text-red-100'
                          : 'bg-[#101014] border-white/10 text-neutral-300'
                      }`}
                    >
                      Rated ≤ 1★ ({lowRatedItems.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setTrashScope('selected')}
                      className={`rounded-md px-3 py-2 text-left border transition ${
                        trashScope === 'selected'
                          ? 'bg-red-500/15 border-red-500/45 text-red-100'
                          : 'bg-[#101014] border-white/10 text-neutral-300'
                      }`}
                    >
                      Selected ({selectedItems.length})
                    </button>
                  </div>
                </div>

                <div className="rounded-md bg-red-500/10 border border-red-500/25 p-3 text-neutral-300 leading-relaxed">
                  Moving <strong className="text-white">{trashItems.length}</strong> logical item(s) (~
                  <strong className="text-white">{countPhysicalFiles(trashItems)}</strong> files including paired
                  RAW+JPG and <code className="text-amber-300">.xmp</code> sidecars) to your system Trash (or local{' '}
                  <code className="text-neutral-200">.PhotoCull_Trash</code> on external/mounted volumes).
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/[0.08]">
                  <button type="button" onClick={onClose} className="px-3 py-1.5 text-neutral-400 hover:text-white">
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={running || trashItems.length === 0}
                    onClick={() => void handleRunTrash()}
                    className="rounded-md bg-red-500 hover:bg-red-400 text-white font-semibold px-4 py-1.5 transition disabled:opacity-40"
                  >
                    {running ? 'Moving to Trash…' : `Move ${trashItems.length} Photo(s) to Trash`}
                  </button>
                </div>
              </>
            )}

            {tab === 'ingest' && (
              <>
                <div className="space-y-1.5">
                  <label className="text-neutral-400 font-medium">Source Folder / SD Card (e.g. DCIM)</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={ingestSource}
                      onChange={(e) => setIngestSource(e.target.value)}
                      placeholder="/mnt/d/DCIM"
                      className="flex-1 rounded-md bg-[#0b0b0e] border border-white/10 px-3 py-1.5 font-mono text-neutral-200 focus:outline-none focus:border-sky-400"
                    />
                    <button
                      type="button"
                      onClick={() => void handleBrowseFolder('ingestSource')}
                      className="rounded-md bg-white/[0.07] hover:bg-white/12 px-2.5 py-1.5 text-neutral-200 flex items-center gap-1"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      Browse
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-neutral-400 font-medium">Destination Root Folder</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={ingestTargetRoot}
                      onChange={(e) => setIngestTargetRoot(e.target.value)}
                      className="flex-1 rounded-md bg-[#0b0b0e] border border-white/10 px-3 py-1.5 font-mono text-neutral-200 focus:outline-none focus:border-sky-400"
                    />
                    <button
                      type="button"
                      onClick={() => void handleBrowseFolder('ingestRoot')}
                      className="rounded-md bg-white/[0.07] hover:bg-white/12 px-2.5 py-1.5 text-neutral-200 flex items-center gap-1"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      Browse
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-neutral-400 font-medium">Shoot Name</label>
                    <input
                      type="text"
                      value={ingestName}
                      onChange={(e) => setIngestName(e.target.value)}
                      className="w-full rounded-md bg-[#0b0b0e] border border-white/10 px-3 py-1.5 text-neutral-200 focus:outline-none focus:border-sky-400"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-neutral-400 font-medium">Folder Template</label>
                    <input
                      type="text"
                      value={ingestTemplate}
                      onChange={(e) => setIngestTemplate(e.target.value)}
                      className="w-full rounded-md bg-[#0b0b0e] border border-white/10 px-3 py-1.5 font-mono text-neutral-200 focus:outline-none focus:border-sky-400"
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2 text-neutral-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeSidecars}
                    onChange={(e) => setIncludeSidecars(e.target.checked)}
                    className="accent-sky-400"
                  />
                  Include existing .xmp sidecar files
                </label>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/[0.08]">
                  <button type="button" onClick={onClose} className="px-3 py-1.5 text-neutral-400 hover:text-white">
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={running || !ingestSource.trim() || !ingestTargetRoot.trim()}
                    onClick={() => void handleRunIngest()}
                    className="rounded-md bg-sky-500 hover:bg-sky-400 text-black font-semibold px-4 py-1.5 transition disabled:opacity-40"
                  >
                    {running ? 'Ingesting…' : 'Ingest & Open Folder'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {browsingFor && (
        <FolderPickerModal
          title={
            browsingFor === 'exportTarget'
              ? 'Select Destination Folder'
              : browsingFor === 'ingestSource'
                ? 'Select Source / SD Card Folder'
                : 'Select Ingest Root Folder'
          }
          confirmLabel="Choose Folder"
          initialDir={
            browsingFor === 'exportTarget'
              ? folder
              : browsingFor === 'ingestRoot'
                ? ingestTargetRoot
                : undefined
          }
          allowGenerateDemo={false}
          onSelectFolder={(chosen) => {
            if (browsingFor === 'exportTarget') setTargetFolder(chosen);
            else if (browsingFor === 'ingestSource') setIngestSource(chosen);
            else setIngestTargetRoot(chosen);
            setBrowsingFor(null);
          }}
          onClose={() => setBrowsingFor(null)}
        />
      )}
    </>
  );
}
