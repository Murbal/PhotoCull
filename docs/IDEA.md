# Idea: Ultra-Fast RAW Photo Culling Tool

## Vision
Build a lightweight, blazingly fast, keyboard-first desktop photo culling application. It should let a photographer open any folder of thousands of RAW/JPEG images directly (no catalog/import step), flip through frames with zero perceptible lag, check sharpness at 100%, rate/tag/reject shots, and hand off the culled selections seamlessly to Lightroom / Capture One / Darktable via standard `.xmp` sidecar files.

## Core Problem
Full RAW editors (Lightroom, Capture One, etc.) are slow for initial culling because they build catalogs and demosaic RAW files. Photographers shooting events, sports, street, or high-burst sessions need instant image switching to whittle 3,000 frames down to 100 keepers in minutes.

## Core Principles
1. **Speed above everything**: Switching between images must feel instantaneous (<16–30ms perceived latency) even on 40–60MP RAW files.
2. **No catalog lock-in**: Operate directly on the filesystem (folders on local drives, external SSDs, SD cards).
3. **Interoperable by default**: Store ratings, color labels, and flags in standard `.xmp` sidecars compatible with Lightroom/Capture One/Darktable.
4. **Keyboard-first**: Every culling action should be doable without touching the mouse.

## Key Features (Rough MVP Scope)

### 1. Instant Viewing Engine
- Extract embedded JPEG previews from RAW files (`.ARW`, `.CR2`, `.CR3`, `.NEF`, `.RAF`, `.DNG`, `.ORF`, `.RW2`, etc.) instead of full RAW demosaicing.
- Multi-threaded background prefetching/caching (preload `N` images ahead and behind the current selection in memory).
- Support standard formats (`.JPG`, `.PNG`, `.HEIC`, `.WEBP`) alongside RAW.
- **RAW+JPEG pairing**: Option to group matching basenames (e.g., `DSC01234.ARW` + `DSC01234.JPG`) into a single logical item so ratings, moves, and deletes stay in sync.

### 2. Views & Inspection
- **Contact Sheet (Grid View)**: Fast virtualized thumbnail grid with configurable thumbnail sizes, star/color badges, and filtering.
- **Single-Image Loupe View**: Full-screen / distraction-free view with instant next/prev navigation.
- **100% Zoom / Focus Check**: Single key/click toggle to 1:1 (and 200%) zoom at cursor or center to verify critical focus.
- **Side-by-Side Compare (2-up)**: Compare two similar frames with synced zoom/pan to pick the sharpest one.
- **Minimal HUD / Info Strip**: Filename, rating, color class, EXIF basics (shutter, aperture, ISO, focal length, lens), and optional RGB histogram.

### 3. Culling & Rating Workflow
- **Keyboard shortcuts** (standard culling workflow defaults, customizable later):
  - `Left` / `Right` (or `J` / `K`): Previous / Next image
  - `1`–`5`: Star ratings (`0` clears)
  - `6`–`9` (or color keys): Color labels
  - `T` or `P`: Tag / Pick; `X`: Reject
  - `Z` or `Space`: Toggle 100% zoom
  - `G`: Toggle Grid / Loupe view
  - Optional **auto-advance** after rating/tagging.
- **Filtering**: Quickly filter grid/loupe by tagged, untagged, star rating (`>= N`), color label, or rejected.

### 4. Sidecar & File Operations
- Read and write standard Adobe `.xmp` sidecar files (`xmp:Rating`, `xmp:Label`, pick/reject flags) without clobbering existing XMP fields from other editors.
- Batch actions on filtered/tagged/rejected photos:
  - Copy / Move tagged keepers to a target folder
  - Delete rejected photos (safe move-to-trash by default)
  - Basic ingest from SD card (copy + optional date/name folder template) *(nice-to-have / Phase 2)*

## Suggested Technical Direction (Open for Exploration)
*The implementing agent should evaluate and propose the best stack before coding, prioritizing raw decoding speed, low memory overhead, and cross-platform native feel (Linux/macOS/Windows).*
- **Likely strong candidates**:
  - **Rust** backend/core (fast EXIF/embedded JPEG extraction via crates like `kamadak-exif` / `rawloader` / `libraw` / custom TIFF/ISOBMFF parser, `rayon` parallel decoding, LRU decoded image cache) + native UI (`egui`, `iced`, `GPUI`, or `Tauri` with custom protocol/canvas)
  - Or **C++ / Qt** or **Swift (macOS-only)** if targeting a single OS.
- **Critical technical challenge**: Handling all modern RAW container formats reliably—especially Canon `.CR3` (ISOBMFF/MP4 box structure), Sony `.ARW`, Nikon `.NEF`, Fujifilm `.RAF`, and `.DNG`—to extract the **largest** embedded preview JPEG rapidly without invoking slow external processes per file.

## Nice-to-Haves (Post-MVP)
- Fast IPTC metadata templates (copyright, caption, keywords, variables like `{year}`, `{camera}`).
- Local AI assist: eye-detection auto-zoom on 100% check, sharpness score badge, burst grouping.
- Highlight/shadow clipping warning overlay.
- Dual-monitor support (Grid on one screen, Loupe on the other).

## Open Questions for the Next Agent
1. Target OS(es) (Linux, macOS, Windows, or cross-platform)?
2. UI framework choice balancing zero-lag GPU texture rendering vs. development velocity.
3. Embedded preview extraction strategy across `.CR3`, `.ARW`, `.NEF`, `.RAF`, `.DNG` (pure Rust vs. `libraw` / `exiv2` bindings).
4. Exact `.xmp` schema compatibility matrix (Lightroom Classic vs. Darktable vs. Capture One color label mappings).
