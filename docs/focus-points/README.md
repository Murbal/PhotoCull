# Focus Point Metadata & Overlay Architecture

This directory documents how to extract, normalize, and render camera-recorded autofocus (AF) point metadata for each camera format supported by PhotoCull. Each camera format has its own specification file in this folder:

- [`fujifilm-raf.md`](./fujifilm-raf.md) — Fujifilm `.RAF` (and out-of-camera Fujifilm `.JPG`)

*(Add new formats as `<vendor>-<ext>.md`, e.g. `canon-cr3.md`, `sony-arw.md`, `nikon-nef.md`, `olympus-orf.md`.)*

---

## Shared Coordinate Contract

Every format parser MUST emit focus points in **normalized upright display coordinates** (`[0..1] × [0..1]`, origin at top-left of the orientation-corrected image), so the UI never needs format-specific or orientation-specific math.

### Why upright coordinates?
In PhotoCull, `src/engine/imageCache.ts` decodes every preview via:

```ts
createImageBitmap(blob, { imageOrientation: 'from-image' })
```

As a result, `DecodedFrame.bitmap` (`frame.width × frame.height`) in `src/components/LoupeCanvas.tsx` is **already rotated upright** according to EXIF `Orientation` (`0x0112`), whereas raw EXIF/MakerNote focus coordinates (and JPEG `SOF` dimensions) are recorded in **unrotated sensor/preview orientation**.

### Proposed Shared Type (`shared/types.ts`)

Add an optional `focus` field to `ExifData`:

```ts
export interface FocusPoint {
  /** Normalized horizontal center in upright display space [0..1] (left → right) */
  x: number;
  /** Normalized vertical center in upright display space [0..1] (top → bottom) */
  y: number;
  /** Optional normalized box width/height in upright display space (when known) */
  width?: number;
  height?: number;
  /** Whether this point was actively locked/selected vs. secondary/face box */
  active?: boolean;
  /** Optional kind for styling (AF point, zone, detected face/eye) */
  kind?: 'af-point' | 'af-zone' | 'face' | 'eye';
}

export interface FocusMetadata {
  /** Primary/selected focus points in normalized upright coordinates */
  points: FocusPoint[];
  /** Human-readable focus mode, e.g. "AF-S", "AF-C", "MF" */
  mode?: string;
  /** Human-readable AF area mode, e.g. "Single Point", "Zone", "Wide/Tracking" */
  areaMode?: string;
  /** True when camera reported focus lock / no focus warning */
  locked?: boolean;
  /** Raw vendor-specific reference size & unrotated coords for debugging/tests */
  raw?: {
    x: number;
    y: number;
    refWidth: number;
    refHeight: number;
    orientation: number;
  };
}
```

And attach `focus?: FocusMetadata;` onto `ExifData` in `shared/types.ts`.

---

## EXIF Orientation Transform (`1..8`)

Given an unrotated normalized coordinate `(nx, ny) = (rawX / refWidth, rawY / refHeight)` in `[0..1] × [0..1]` (origin top-left of the unrotated reference image), transform to upright display space `(ux, uy)` using the EXIF `Orientation` tag (`0x0112`, default `1`):

| EXIF Orientation | Meaning | Upright `(ux, uy)` | Dimensions Swapped? |
| --- | --- | --- | --- |
| `1` | Horizontal (normal) | `(nx, ny)` | No |
| `2` | Mirror horizontal | `(1 - nx, ny)` | No |
| `3` | Rotate 180° | `(1 - nx, 1 - ny)` | No |
| `4` | Mirror vertical | `(nx, 1 - ny)` | No |
| `5` | Mirror horizontal + Rotate 270° CW | `(ny, nx)` | Yes |
| `6` | Rotate 90° CW | `(1 - ny, nx)` | Yes |
| `7` | Mirror horizontal + Rotate 90° CW | `(1 - ny, 1 - nx)` | Yes |
| `8` | Rotate 270° CW (90° CCW) | `(ny, 1 - nx)` | Yes |

*(If a focus box also carries `(nw, nh)` in unrotated normalized space, swap `(uw, uh) = (nh, nw)` whenever `orientation >= 5`.)*

```ts
export function applyExifOrientation(
  nx: number,
  ny: number,
  orientation = 1,
): { x: number; y: number } {
  switch (orientation) {
    case 2: return { x: 1 - nx, y: ny };
    case 3: return { x: 1 - nx, y: 1 - ny };
    case 4: return { x: nx, y: 1 - ny };
    case 5: return { x: ny, y: nx };
    case 6: return { x: 1 - ny, y: nx };
    case 7: return { x: 1 - ny, y: 1 - nx };
    case 8: return { x: ny, y: 1 - nx };
    case 1:
    default:
      return { x: nx, y: ny };
  }
}
```

### Important Guardrails
1. **Clamp/validate bounds**: Discard or mark invalid any raw focus coordinate where `refWidth <= 0`, `refHeight <= 0`, `rawX > refWidth`, or `rawY > refHeight`.
2. **Wait until `IFD0` and `ExifIFD` are both parsed**: In TIFF containers, `Orientation` (`0x0112`) lives in `IFD0`, while `MakerNote` (`0x927C`) and `ExifImageWidth`/`ExifImageHeight` (`0xA002`/`0xA003`) live in `ExifIFD`. Always apply `applyExifOrientation` **after** all relevant IFDs have been read (not eagerly inside the MakerNote parser before `Orientation` is guaranteed populated).
3. **Never double-rotate in the frontend**: `LoupeCanvas.tsx` draws `frame.bitmap` already upright, so coordinates `(fp.x, fp.y)` map directly onto the drawn rectangle `(dx, dy, drawW, drawH)`.

---

## Frontend Rendering & Zoom-to-Focus-Point (`src/components/LoupeCanvas.tsx`)

Inside `LoupeCanvas.tsx`, the upright preview is drawn at `(dx, dy)` with dimensions `(drawW, drawH)`:

### 1. Drawing the focus reticle on the canvas
```ts
const cx = dx + fp.x * drawW;
const cy = dy + fp.y * drawH;
```
- If `fp.width` and `fp.height` are present, draw a rectangle of size `fp.width * drawW` × `fp.height * drawH` centered at `(cx, cy)`.
- Otherwise (e.g., center-only AF points), draw a clean reticle/bracket whose visual size scales nicely in screen pixels (or a small fraction of `Math.min(drawW, drawH)`).
- You can also render the focus point dot inside the zoomed-in minimap at `(mx + fp.x * mw, my + fp.y * mh)`.

### 2. Jumping/zooming to 100% centered on the focus point
`ViewportTransform` stores `panX` and `panY` in upright image pixels relative to the image center:
```ts
const targetPanX = (fp.x - 0.5) * frame.width;
const targetPanY = (fp.y - 0.5) * frame.height;
const clamped = clampPan(targetPanX, targetPanY, 1.0, frame);
onViewportChange({
  zoomMode: '100',
  scale: 1.0,
  panX: clamped.panX,
  panY: clamped.panY,
});
```

---

## Checklist When Adding a New Camera Format Doc

Each format file in `docs/focus-points/` should include:
1. Container path to the MakerNote / focus metadata (exact byte offsets, magic strings, endianness, offset base).
2. Exact tag IDs, TIFF types, bitfield layouts, and value enums.
3. Exact reference coordinate space (preview vs. full sensor vs. fixed virtual grid) and origin.
4. Orientation behavior (whether raw coords are unrotated or pre-rotated).
5. Edge cases (manual focus, AF-C / tracking, multiple points, face/eye detection, cropped/re-saved files).
6. Concrete verified test vectors (real file byte snippets + expected upright output) so automated unit tests can lock in correctness.
