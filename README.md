# PhotoCull — Ultra-Fast RAW Photo Culling Desktop App (Electron)

> **Personal project — shared as-is.** This is a personal tool built for my own workflow and is not actively maintained for external users. Feel free to use or fork it under the [MIT License](./LICENSE), but issues, feature requests, and pull requests are not monitored. Because the app writes `.xmp` sidecars and can move or trash files on disk, always keep backups of your photos.

A lightweight, blazingly fast, keyboard-first **Electron desktop application** for photographers. Open any local folder, external SSD, or SD card of thousands of RAW/JPEG images directly (zero catalog/import step), flip through frames with zero perceptible lag, verify 100%/200% sharpness, rate shots 1–5 stars, and sync clean standard `xmp:Rating` sidecars seamlessly with **Lightroom Classic**, **Capture One**, and **Darktable**.

## Desktop Architecture & Why It's Fast

1. **Electron Main Process + Custom `photocull://` Protocol (`electron/main.ts`, `electron/preload.ts`)**:
   - Registers a privileged `photocull://image` protocol handler directly in Electron's main process so `<img>`, `fetch()`, and `createImageBitmap()` stream extracted RAW embedded JPEGs straight from disk with **zero HTTP server / TCP socket overhead**.
   - Native OS integration: OS folder dialogs (`Cmd/Ctrl+O`), native **System Trash / Recycle Bin** (`shell.trashItem`), **Reveal in Finder / Explorer / File Manager** (`Cmd/Ctrl+Shift+R`), **Drag & Drop folder onto window**, native application menu, single-instance lock, and window bounds persistence.

2. **Zero-Process Native Binary RAW Extractor (`server/raw/`)**:
   - Uses positional reads (`FileHandle.read`) instead of reading 50–60MB RAW sensor data or spawning slow external processes (`exiftool`/`dcraw`).
   - Parses TIFF/IFD/SubIFD/MakerNote chains (`.ARW`, `.NEF`/`.NRW`, `.CR2`, `.DNG`, `.ORF`, `.RW2`, `.PEF`, `.SRW`, `.MRW`), Canon **ISOBMFF `.CR3`** boxes (`moov/trak` full-res JPEG in `mdat`, `PRVW`, `THMB`, `CMT1`/`CMT2` EXIF), and Fujifilm **`.RAF`** headers to extract the **largest embedded preview JPEG** and optimal contact-sheet thumbnail.

3. **Off-Main-Thread `ImageBitmap` LRU Prefetch Engine (`src/engine/imageCache.ts`)**:
   - Decodes JPEGs off the main thread via `createImageBitmap(blob, { imageOrientation: 'from-image' })`.
   - Directionally prefetches **8 frames ahead / 4 behind** with automatic `AbortController` cancellation during rapid arrow-key scrubbing and explicit `.close()` GPU memory cleanup on LRU eviction.
   - Switching to a prefetched frame renders synchronously onto the GPU-backed `<canvas>` in **< 1ms**.

4. **Non-Destructive Standard `.xmp` Sidecars (`server/xmp.ts`)**:
   - Atomically reads and patches only `xmp:Rating` (`1`–`5`, removed when `0`) while preserving all existing Lightroom (`crs:*`), Darktable (`darktable:*`), IPTC, and keyword (`dc:subject`) fields verbatim.

## Getting Started

```bash
# Install dependencies (and Electron binary)
bun install

# Launch Electron desktop app in development mode (Vite HMR + Electron)
bun run dev
# Or open a specific photo folder directly:
bun run dev /path/to/your/photos

# Build production Electron desktop app & launch
bun run build
bun run start

# Package installable desktop binaries (current OS: Linux AppImage/deb, macOS dmg, Windows nsis/portable)
bun run package

# Package for Windows (x64 — NSIS + Portable .exe on Windows/Wine, or ready-to-run .zip + PhotoCull.exe on Linux/WSL2 without Wine)
bun run package:win
# Or individual Windows targets:
bun run package:win:zip
bun run package:win:portable
bun run package:win:nsis
bun run package:win:dir
```

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + O` | Open Photo Folder (native OS picker) |
| `←` / `→` or `J` / `K` | Previous / Next frame |
| `1` – `5` / `0` | Set star rating (`xmp:Rating`) / Clear rating |
| `Z` or `Space` or Click | Toggle 100% (1:1) Focus Zoom (`Shift+Z` for 200%) |
| `G` or `Enter` | Toggle Grid / Loupe view |
| `C` | Toggle 2-Up Side-by-Side Compare (`S` to swap) |
| `A` | Toggle Auto-Advance after rating |
| `F` / `I` / `O` | Toggle Filmstrip / HUD+Histogram / Clipping Warning |
| `R` | Toggle RAW+JPEG Pairing |
| `[` / `]` | Decrease / Increase Grid thumbnail size |
| `Ctrl/Cmd + Z` | Undo last rating change |
| `Ctrl/Cmd + Shift + R` | Reveal active photo in Finder / Explorer / File Manager |
| `?` or `F1` | Show Shortcuts overlay |

## Testing & Verification

```bash
bun run typecheck
bun test
bun run build
```
