import { Keyboard, X } from 'lucide-react';

interface ShortcutsModalProps {
  onClose: () => void;
}

const SHORTCUT_GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Navigation & Views',
    rows: [
      ['Cmd/Ctrl + O', 'Open Photo Folder'],
      ['← / →  or  J / K', 'Previous / Next image'],
      ['↑ / ↓', 'Navigate rows in Grid view'],
      ['Home / End', 'First / Last image'],
      ['G  or  Enter', 'Toggle Grid (Contact Sheet) / Loupe view'],
      ['C', 'Toggle 2-Up Side-by-Side Compare view'],
      ['S', 'Swap Select & Candidate in Compare view'],
      ['F', 'Toggle bottom Filmstrip in Loupe view'],
      ['[ / ]', 'Decrease / Increase Grid thumbnail size'],
    ],
  },
  {
    title: 'Star Ratings (.xmp)',
    rows: [
      ['1 – 5', 'Set star rating (xmp:Rating)'],
      ['0', 'Clear star rating'],
      ['A', 'Toggle Auto-Advance after rating'],
      ['Ctrl/Cmd + Z', 'Undo last rating change'],
      ['Ctrl/Cmd + A', 'Select all visible photos'],
    ],
  },
  {
    title: 'Focus Check & Inspection',
    rows: [
      ['Z  or  Space  or  Click', 'Toggle 100% (1:1) Focus Zoom'],
      ['Shift + Z', 'Toggle 200% Pixel Zoom'],
      ['Drag  (when zoomed)', 'Pan image (synced in 2-Up Compare)'],
      ['I', 'Toggle HUD / EXIF / RGB Histogram'],
      ['O', 'Toggle Highlight & Shadow Clipping Overlay'],
      ['R', 'Toggle RAW+JPEG Pairing'],
      ['?', 'Toggle this Shortcuts overlay'],
    ],
  },
];

export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl bg-[#151519] border border-white/12 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.08]">
          <div className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-neutral-100">Keyboard Shortcuts</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-6 text-xs max-h-[75vh] overflow-y-auto">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title} className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-amber-400/90">
                {group.title}
              </h3>
              <div className="space-y-1.5">
                {group.rows.map(([keys, desc]) => (
                  <div key={keys} className="flex items-center justify-between gap-3 py-1 border-b border-white/[0.04]">
                    <span className="text-neutral-300">{desc}</span>
                    <kbd className="shrink-0 rounded bg-[#0c0c0f] border border-white/12 px-1.5 py-0.5 font-mono text-[10px] text-neutral-200">
                      {keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
