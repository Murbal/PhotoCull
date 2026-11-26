import { useEffect, useState } from 'react';
import { ArrowUp, Folder, FolderOpen, HardDrive, Sparkles, X } from 'lucide-react';
import type { BrowseResult } from '../../shared/types.js';
import { browseDir, generateDemoShootApi } from '../api/client.js';

interface FolderPickerModalProps {
  title?: string;
  confirmLabel?: string;
  initialDir?: string;
  recentFolders?: string[];
  allowGenerateDemo?: boolean;
  onSelectFolder: (folderPath: string) => void;
  onClose: () => void;
}

export function FolderPickerModal({
  title = 'Open Photo Folder',
  confirmLabel = 'Open This Folder',
  initialDir,
  recentFolders = [],
  allowGenerateDemo = true,
  onSelectFolder,
  onClose,
}: FolderPickerModalProps) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [pathInput, setPathInput] = useState(initialDir || '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatingDemo, setGeneratingDemo] = useState(false);

  const navigate = async (dir?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await browseDir(dir);
      setData(res);
      setPathInput(res.current);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void navigate(initialDir || undefined);
  }, [initialDir]);

  const handleGoPath = (e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) void navigate(pathInput.trim());
  };

  const handleCreateDemo = async () => {
    setGeneratingDemo(true);
    setError(null);
    try {
      const res = await generateDemoShootApi(24);
      onSelectFolder(res.folder);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingDemo(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[82vh] flex flex-col rounded-xl bg-[#151519] border border-white/12 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.08]">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Path Bar */}
        <form onSubmit={handleGoPath} className="flex items-center gap-2 px-4 py-2.5 bg-[#101014] border-b border-white/[0.06]">
          <button
            type="button"
            disabled={!data?.parent || loading}
            onClick={() => data?.parent && void navigate(data.parent)}
            className="rounded p-1.5 bg-white/[0.05] hover:bg-white/10 disabled:opacity-35 text-neutral-300 transition"
            title="Parent directory"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="/path/to/your/photos"
            className="flex-1 rounded-md bg-[#0b0b0e] border border-white/10 px-3 py-1.5 text-xs font-mono text-neutral-200 focus:outline-none focus:border-amber-400/70"
          />
          <button
            type="submit"
            className="rounded-md bg-white/[0.07] hover:bg-white/12 px-3 py-1.5 text-xs font-medium text-neutral-200 transition"
          >
            Go
          </button>
        </form>

        {/* Body */}
        <div className="flex-1 min-h-0 grid grid-cols-[200px_1fr] divide-x divide-white/[0.07]">
          {/* Sidebar quick paths & recents */}
          <div className="overflow-y-auto p-2.5 space-y-4 bg-[#111115]">
            <div>
              <div className="px-2 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                Locations
              </div>
              <div className="space-y-0.5">
                {data?.quickPaths.map((qp) => (
                  <button
                    key={qp.path}
                    type="button"
                    onClick={() => void navigate(qp.path)}
                    className={`w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition ${
                      data.current === qp.path
                        ? 'bg-amber-500/15 text-amber-200'
                        : 'text-neutral-300 hover:bg-white/[0.06]'
                    }`}
                  >
                    <HardDrive className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                    <span className="truncate">{qp.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {recentFolders.length > 0 && (
              <div>
                <div className="px-2 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                  Recent
                </div>
                <div className="space-y-0.5">
                  {recentFolders.map((rf) => (
                    <button
                      key={rf}
                      type="button"
                      onClick={() => onSelectFolder(rf)}
                      title={rf}
                      className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-200 transition"
                    >
                      <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-600" />
                      <span className="truncate">{rf.split('/').pop() || rf}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Directory list */}
          <div className="overflow-y-auto p-2 bg-[#151519]">
            {error && (
              <div className="m-2 rounded-md bg-red-500/15 border border-red-500/30 px-3 py-2 text-xs text-red-200">
                {error}
              </div>
            )}
            {loading ? (
              <div className="flex items-center justify-center h-40 text-xs text-neutral-500">
                Scanning directory…
              </div>
            ) : data && data.directories.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                {data.directories.map((d) => (
                  <button
                    key={d.path}
                    type="button"
                    onClick={() => void navigate(d.path)}
                    onDoubleClick={() => onSelectFolder(d.path)}
                    className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-neutral-200 hover:bg-white/[0.06] transition group"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-amber-400/75 group-hover:text-amber-300" />
                    <span className="truncate">{d.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-40 text-xs text-neutral-500">
                No subdirectories here.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 bg-[#101014] border-t border-white/[0.08]">
          <div className="flex items-center gap-3 text-xs text-neutral-400">
            {data && (
              <span>
                <strong className="text-neutral-200 tabular-nums">{data.photoCountHere}</strong> photo
                {data.photoCountHere === 1 ? '' : 's'} in this folder
              </span>
            )}
            {allowGenerateDemo && (
              <button
                type="button"
                disabled={generatingDemo}
                onClick={() => void handleCreateDemo()}
                className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.06] hover:bg-white/10 border border-white/10 px-2.5 py-1 text-xs text-amber-300 transition disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {generatingDemo ? 'Generating RAWs…' : 'Create & Open Demo RAW Shoot'}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!pathInput.trim()}
              onClick={() => onSelectFolder(pathInput.trim())}
              className="rounded-md bg-amber-500 hover:bg-amber-400 text-black font-semibold px-4 py-1.5 text-xs transition disabled:opacity-40"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
