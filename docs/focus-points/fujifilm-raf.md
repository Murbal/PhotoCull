# Fujifilm `.RAF` Focus Point Specification

> **Verification status:** Empirically verified on 114 Fujifilm **X-T5** (firmware `Ver4.31`) `.RAF` files across both landscape (`Orientation = 1`) and portrait (`Orientation = 8`) captures, validated against the X-T5 425-point AF grid (`≤ 1.50 px` residual), optical plane-of-focus Laplacian sharpness profiles, and cross-axis falsification tests on shallow-DoF (`f/2.8`) off-center shots.

---

## 1. Binary Location Inside `.RAF`

Fujifilm `.RAF` files store focus point metadata inside the **EXIF `APP1` segment of the embedded preview JPEG** — not in the CFA header or raw sensor payload. Because PhotoCull already parses this exact `APP1` TIFF container via `parseRafContainer()` → `parseTiffContainer()`, extracting focus data requires **zero additional disk reads** beyond the existing 256 KB header preload in `BinaryReader`.

### Path from byte 0 of `.RAF`

1. **RAF Container Header** (big-endian):
   - `0x00..0x0F`: ASCII magic `"FUJIFILMCCD-RAW "` (16 bytes)
   - `0x54..0x57`: `jpegOffset` (`uint32 BE`, typically `148`)
   - `0x58..0x5B`: `jpegLength` (`uint32 BE`)
   - *(Note: `0x5C..0x63` points to the CFA header directory, where tags `0x0111`/`0x0112` give the full active sensor resolution such as `7728 × 5152` on X-T5. Do **not** use those dimensions to normalize `FocusPixel` — see Section 4.)*
2. **Embedded JPEG at `jpegOffset`**:
   - Scan JPEG markers until `APP1` (`0xFFE1`) beginning with `"Exif\0\0"` (6 bytes).
   - The TIFF container begins immediately after `"Exif\0\0"` (`baseOffset = jpegOffset + app1.offset`).
   - JPEG `SOF0` (`0xFFC0`) also records the preview dimensions (`width × height`, e.g. `4416 × 2944`), matching `ExifImageWidth × ExifImageHeight`.
3. **EXIF TIFF Container** (typically little-endian `"II\x2A\x00"`):
   - **`IFD0`**:
     - `0x010F` (`Make`): `"FUJIFILM"`
     - `0x0112` (`Orientation`, `uint16`): `1..8` (e.g. `1` = landscape, `8` = Rotate 270° CW / 90° CCW)
     - `0x8769` (`ExifIFD`, `uint32`): offset relative to TIFF `baseOffset`
   - **`ExifIFD`**:
     - `0xA002` (`ExifImageWidth`, `uint32` or `uint16`): embedded preview width (e.g. `4416`)
     - `0xA003` (`ExifImageHeight`, `uint32` or `uint16`): embedded preview height (e.g. `2944`)
     - `0x927C` (`MakerNote`, `UNDEFINED`): offset `valueOrOffset` relative to TIFF `baseOffset`, length `totalBytes`
4. **Fujifilm MakerNote Container** (at `mnAbsOffset = baseOffset + makerNoteEntry.valueOrOffset`):
   - **CRITICAL QUIRK — Endianness & Offset Base:**
     - Bytes `0..7`: ASCII signature `"FUJIFILM"` (8 bytes)
     - Bytes `8..11`: `ifdRelOffset` (`uint32 LE`, typically `12` = `0x0000000C`)
     - **Always little-endian** (`II`), even if the outer TIFF container were big-endian.
     - **All offsets inside the Fujifilm MakerNote IFD are relative to `mnAbsOffset` (byte 0 of `"FUJIFILM"`), NOT relative to the outer EXIF TIFF `baseOffset`.**
   - At `mnAbsOffset + ifdRelOffset`, parse a standard little-endian TIFF IFD:
     - `uint16 LE` entry count (e.g. `75`)
     - `count × 12`-byte entries: `tag (u16 LE)`, `type (u16 LE)`, `count (u32 LE)`, `valueOrOffset (4 bytes inline if totalBytes ≤ 4, else u32 LE offset relative to mnAbsOffset)`

*(Note: Out-of-camera Fujifilm `.JPG` files use the exact same `APP1` → `ExifIFD` → `FUJIFILM` MakerNote layout, so supporting it inside `parseTiffContainer()` automatically covers both `.RAF` and `.JPG`.)*

---

## 2. Fujifilm MakerNote Focus Tag Reference

All tag definitions follow ExifTool's `Image::ExifTool::FujiFilm` table and were verified against X-T5 `.RAF` binaries:

| Tag ID | Name | TIFF Type | Count | Meaning / Decoding |
| --- | --- | --- | --- | --- |
| **`0x1023`** | **`FocusPixel`** | `SHORT` (`3`) | `2` | **`[rawX, rawY]`** — **2 × `uint16 LE` stored inline in the 4-byte value field** (`rawX = value[0..1]`, `rawY = value[2..3]`). Center pixel of the active/selected AF point in **unrotated `ExifImageWidth × ExifImageHeight` preview space**. |
| `0x1021` | `FocusMode` | `SHORT` (`3`) | `1` | `0` = Auto, `1` = Manual, `65535` = Movie |
| `0x1022` | `AFMode` | `SHORT` (`3`) | `1` | `0` = No (manual / multi), `1` = Single Point, `256` (`0x0100`) = Zone, `512` (`0x0200`) = Wide/Tracking |
| `0x102B` | `PrioritySettings` | `SHORT` (`3`) | `1` | Bitfield: `AF-SPriority = val & 0x0f` (`1` = Focus, `2` = Release); `AF-CPriority = (val >> 4) & 0x0f` (`1` = Focus, `2` = Release) |
| **`0x102D`** | **`FocusSettings`** | `LONG` (`4`) | `1` | Packed `uint32 LE` bitfield (see table below) |
| `0x102E` | `AFCSettings` | `LONG` (`4`) | `1` | AF-C custom tracking settings (`TrackingSensitivity = val & 0x0f`, `SpeedTrackingSensitivity = (val >> 4) & 0x0f`, `ZoneAreaSwitching = (val >> 8) & 0x0f`) |
| `0x1301` | `FocusWarning` | `SHORT` (`3`) | `1` | `0` = Good (focus acquired), `1` = Out of focus |
| `0x4100` | `FacesDetected` | `SHORT` (`3`) | `1` | Number of detected faces (`0` when none) |
| `0x4103` | `FacePositions` | `SHORT` (`3`) | `4 × N` | Present when `FacesDetected > 0`; 4 `uint16` values `[top, left, bottom, right]` per face in the same preview coordinate space *(not yet verified on a face-containing sample in this repo — verify ordering `[top, left, bottom, right]` vs `[left, top, right, bottom]` before enabling face boxes)* |
| `0x4200` | `NumFaceElements` | `SHORT` (`3`) | `1` | Number of face/subject detection elements (`0` when none) |

### Bitfield Layout of `0x102D` (`FocusSettings`, `uint32 LE`)

| Sub-field | Extraction | Values |
| --- | --- | --- |
| `FocusMode2` | `val & 0x0f` | `0` = AF-M (Manual), `1` = AF-S (Single), `2` = AF-C (Continuous) |
| `PreAF` | `(val >> 4) & 0x0f` | `0` = Off, `1` = On |
| `AFAreaMode` | `(val >> 8) & 0x0f` | `0` = Single Point, `1` = Zone, `2` = Wide/Tracking |
| `AFAreaPointSize` | `(val >> 12) & 0x0f` | `0` = n/a; `1..6` = discrete AF box size step (smallest → largest single-point box) |
| `AFAreaZoneSize` | `(val >> 16) & 0xff` | `0` = n/a; non-zero = zone grid configuration (e.g. `3×3`, `5×5`, `7×7`) |

---

## 3. Coordinate Space & Orientation Transform

### Reference Dimensions (`refWidth × refHeight`)
- **`FocusPixel` (`0x1023`) is ALWAYS in the unrotated embedded preview coordinate space: `ExifImageWidth × ExifImageHeight`** (tags `0xA002` and `0xA003`, which match the embedded JPEG `SOF` width × height — e.g. **`4416 × 2944`** on X-T5, **NOT** the `7728 × 5152` full RAW sensor resolution).
- Origin `(0, 0)` is the **top-left** of the unrotated landscape sensor/preview image:
  - `rawX` increases left → right (`0 .. refWidth - 1`)
  - `rawY` increases top → bottom (`0 .. refHeight - 1`)
- If `0xA002`/`0xA003` are missing (rare), fall back to the unrotated embedded JPEG `SOF` dimensions (`preview.width × preview.height`).
- To map to full active RAW sensor coordinates (if ever needed outside the preview pipeline), multiply by `rawActiveWidth / refWidth` (on X-T5: `7728 / 4416 = 1.75` exactly).

### Normalization & Upright Rotation
1. Normalize in unrotated space:
   ```ts
   const nx = rawX / refWidth;
   const ny = rawY / refHeight;
   ```
2. Apply the standard EXIF `Orientation` (`0x0112`) transform from [`README.md`](./README.md#exif-orientation-transform-18):
   - For `Orientation = 1` (landscape): `(ux, uy) = (nx, ny)`
   - For `Orientation = 8` (portrait, Rotate 270° CW / 90° CCW): `(ux, uy) = (ny, 1 - nx)`
     - In upright portrait pixels (`refHeight × refWidth` = `2944 × 4416`):
       `x_upright = rawY`, `y_upright = refWidth - rawX`
   - For `Orientation = 6` (portrait, Rotate 90° CW): `(ux, uy) = (1 - ny, nx)`

### AF Box Size Caveat
Fujifilm does **not** store an explicit pixel width/height for the Single-Point AF box in `0x1023`. It stores:
- the exact **center point** in `0x1023` (`FocusPixel`), and
- the discrete **size step** `1..6` in `FocusSettings >> 12 & 0x0f` (`AFAreaPointSize`).

On the X-T5, the 425-point (25 × 17) AF grid pitch is `~153.75 px` in `4416 × 2944` space (`~3.48%` of the long edge, `~5.22%` of the short edge). For UI overlays, either draw a fixed-size reticle/crosshair around `(ux, uy)` or scale an approximate box visually using `AFAreaPointSize` without claiming pixel-exact AF box boundaries.

---

## 4. Edge Cases & Pitfalls

1. **Manual Focus (`FocusMode === 1` or `FocusMode2 === 0` or `AFMode === 0`)**:
   - The camera may still write the last-used AF point or `[0, 0]` into `0x1023`. Check `FocusMode` / `FocusMode2` / `AFMode`: when manual focus is active, either omit the AF point or render it clearly tagged as `MF` (not active AF lock).
2. **`FocusPixel` = `[0, 0]` or out of bounds**:
   - Reject if `rawX === 0 && rawY === 0` or `rawX >= refWidth` or `rawY >= refHeight`.
3. **Inline vs. Offset Value Field for `0x1023`**:
   - Tag `0x1023` has `type = 3 (SHORT)` and `count = 2`, so `totalBytes = 4`. In standard 32-bit TIFF IFDs, 4-byte values are stored **inline** in bytes `8..11` of the 12-byte IFD entry:
     - `rawX = entryBuf.readUInt16LE(8)`
     - `rawY = entryBuf.readUInt16LE(10)`
   - Do **not** treat bytes `8..11` as a file offset!
4. **DNG-Converted Files**:
   - Adobe DNG Converter strips or alters `ExifImageWidth`/`ExifImageHeight` and may strip Fujifilm MakerNotes. Never rely on `0x1023` unless `refWidth`/`refHeight` still match the MakerNote's preview coordinate space.
5. **RAF+JPEG Pairing**:
   - In PhotoCull, when a `.RAF` and `.JPG` are paired, EXIF is parsed from `primaryFile`. If a user externally cropped/resized the `.JPG`, `ExifImageWidth`/`ExifImageHeight` could diverge from `FocusPixel` if the editor kept MakerNotes without updating `FocusPixel`. Preferring `.RAF` for focus metadata (when paired) avoids edited-JPEG drift.
6. **Wide/Tracking & Zone Modes**:
   - In Zone mode (`AFMode === 256`, `AFAreaMode === 1`), `0x1023` still gives the active point center inside the zone (confirmed on X-T5 files with `0x1022 = 256`, `0x102D = 0x00E70101`).
7. **Other Unrelated Tags Near `0x1023`**:
   - `0x1025` (`uint32`) and `0x102C` (`uint32`) sit adjacent to `0x1023`/`0x102D` in X-T5 MakerNotes. Do not confuse them with focus coordinates (`0x1025` varies per focus distance/lens state across shots sharing the same AF point; `0x102C` toggles between `0`, `0x10001`, and `0x20001` across consecutive frames).

---

## 5. PhotoCull Integration Blueprint

No new dependencies are required. All building blocks already exist in `server/raw/`:

1. **`shared/types.ts`**:
   - Add `FocusPoint` and `FocusMetadata` (per [`README.md`](./README.md#proposed-shared-type-sharedtypests)) and add `focus?: FocusMetadata` to `ExifData`.
2. **`server/raw/tiffParser.ts`**:
   - Read `0xA002` (`ExifImageWidth`) and `0xA003` (`ExifImageHeight`) into local `exifImageWidth` / `exifImageHeight` variables during the IFD loop.
   - In the existing `entries.get(0x927c)` MakerNote branch (currently lines ~292–296 where `parseOlympusMakerNote` is called), check for `"FUJIFILM"` header and call a new `parseFujifilmMakerNote(reader, mnOffset, makerNoteEntry.totalBytes)` helper:
     - Verify first 8 bytes === `"FUJIFILM"`.
     - Read `ifdRel = head.readUInt32LE(8)`.
     - Read entry count `u16 LE` at `mnOffset + ifdRel`, then `count * 12` bytes.
     - Extract inline tags `0x1021`, `0x1022`, `0x1023` (`readUInt16LE(off + 8)` and `readUInt16LE(off + 10)`), `0x102D` (`readUInt32LE(off + 8)`), `0x1301` (`readUInt16LE(off + 8)`).
   - **After** the `while (queue.length > 0)` loop completes (so `exif.orientation`, `exifImageWidth`, and `exifImageHeight` are all guaranteed populated):
     - Resolve `refWidth = exifImageWidth || fallbackPreviewWidth`, `refHeight = exifImageHeight || fallbackPreviewHeight`.
     - Validate bounds, normalize `(rawX / refWidth, rawY / refHeight)`, apply `applyExifOrientation(nx, ny, exif.orientation ?? 1)`, and populate `exif.focus`.
3. **`server/raw/rafParser.ts`**:
   - Already calls `parseTiffContainer(reader, jpegOffset + app1.offset, { maxIfds: 8 })` and passes `exif` directly through. Optionally pass `mainCand` width/height as fallback reference dimensions if `0xA002`/`0xA003` are absent.
4. **`src/components/LoupeCanvas.tsx` & `src/App.tsx`**:
   - Add a toggleable Focus Point overlay (e.g., shortcut `F` or toolbar toggle) that draws `item.exif?.focus?.points` onto the canvas and minimap, plus optional "zoom 100% to focus point" action.

---

## 6. Verified Test Vectors (Real X-T5 `.RAF` Files)

Use these real measurements to write unit tests in `tests/raw-and-xmp.test.ts` (including synthetic minimal RAF/TIFF buffers containing the exact 12-byte MakerNote entries):

### Binary Byte-Level Fixture (`20261122-110.RAF`, X-T5 Ver4.31)
- Embedded JPEG: `offset = 148`, `length = 5472022`, `4416 × 2944`
- `IFD0` `Orientation` (`0x0112`) at file byte `194` (`0x00C2`):
  `12 01 03 00 01 00 00 00 08 00 00 00` → `8` (Rotate 270° CW / 90° CCW)
- `MakerNote` `FocusPixel` (`0x1023`) at file byte `2634` (`0x0A4A`):
  `23 10 03 00 02 00 00 00 05 08 59 03` → `[2053, 857]`
- `MakerNote` `FocusSettings` (`0x102D`) at file byte `2694` (`0x0A86`):
  `2d 10 04 00 01 00 00 00 01 60 00 00` → `0x00006001` (`AF-S`, `PreAF=Off`, `Single Point`, `AFAreaPointSize=6`)

### Expected Normalized & Pixel Outputs

| Sample | Lens / Aperture | `Orientation` | `ExifImage` (raw) | Raw `0x1023` `[x, y]` | Upright Pixels | Normalized Upright `(ux, uy)` | Visual Subject Verified |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `20261122-110.RAF` | 50mm `f/4.0` | `8` (270° CW) | `4416 × 2944` | `[2053, 857]` | `(857, 2363)` of `2944 × 4416` | `(0.2911, 0.5351)` | Top edge of sign's circular shadow; optical sharpness peaks at `Y = 54%` |
| `20261122-100.RAF` | 50mm `f/4.0` | `8` (270° CW) | `4416 × 2944` | `[3129, 1625]` | `(1625, 1287)` of `2944 × 4416` | `(0.5520, 0.2914)` | Sharp wet grass/oak leaves (X-flip hits blurred foreground) |
| `20261122-93.RAF` | 18mm `f/4.0` | `8` (270° CW) | `4416 × 2944` | `[2207, 2240]` | `(2240, 2209)` of `2944 × 4416` | `(0.7609, 0.5002)` | Lit wet ivy leaf (Y-flip hits pitch-black background) |
| `20261122-11.RAF` | 50mm `f/2.8` | `1` (Normal) | `4416 × 2944` | `[1900, 2086]` | `(1900, 2086)` of `4416 × 2944` | `(0.4303, 0.7086)` | Sharp backlit twig (Y-flip hits bokeh balls; X-flip hits empty sky) |
| `20261122-111.RAF` | 50mm `f/4.0` | `1` (Normal) | `4416 × 2944` | `[2207, 1472]` | `(2207, 1472)` of `4416 × 2944` | `(0.4998, 0.5000)` | Exact center AF point (col 12, row 8 of 25 × 17 grid) |

### X-T5 425-Point AF Grid Sanity Formula (4416 × 2944 preview space)
Across all 114 captures in the test shoot, every recorded `[rawX, rawY]` fit the 25 × 17 AF grid (`col ∈ 0..24`, `row ∈ 0..16`, center `(12, 8)`) within `1.50 px` in X and `0.88 px` in Y:
- `rawX ≈ 2207.5 + (col - 12) × 153.75`
- `rawY ≈ 1471.5 + (row - 8) × 153.6875`
