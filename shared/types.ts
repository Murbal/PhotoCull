export type PhotoKind = 'raw' | 'image' | 'raw+jpeg';

export interface ExifData {
  make?: string;
  model?: string;
  lens?: string;
  exposureTime?: string;      // e.g. "1/1000" or "2.5"
  exposureTimeSec?: number;
  fNumber?: number;           // e.g. 2.8
  iso?: number;               // e.g. 400
  focalLength?: number;       // mm, e.g. 85
  focalLength35mm?: number;   // mm
  dateTimeOriginal?: string;  // ISO-ish or EXIF date string
  orientation?: number;       // 1..8 EXIF orientation
  width?: number;
  height?: number;
}

export interface PhotoMetadata {
  rating: number;             // 0..5 (stored in xmp:Rating)
  hasXmp: boolean;
}

export interface PhotoItem {
  id: string;                 // stable hash/key for this folder session (e.g. primary filename)
  baseName: string;           // filename without extension (case-preserved)
  displayName: string;        // primary filename shown in UI
  primaryFile: string;        // filename used for preview/EXIF/primary ops
  rawFile: string | null;     // e.g. DSC01234.ARW
  jpegFile: string | null;    // e.g. DSC01234.JPG
  rawExt: string | null;      // uppercase e.g. "ARW", "CR3", "NEF"
  jpegExt: string | null;     // uppercase e.g. "JPG", "PNG", "HEIC"
  kind: PhotoKind;
  sizeBytes: number;          // combined size of linked files
  mtimeMs: number;
  metadata: PhotoMetadata;
  exif?: ExifData;
}

export interface FolderScanResult {
  folder: string;
  pairingEnabled: boolean;
  totalFiles: number;
  scanMs: number;
  items: PhotoItem[];
}

export interface DirectoryEntry {
  name: string;
  path: string;
  photoCount?: number;
}

export interface BrowseResult {
  current: string;
  parent: string | null;
  directories: DirectoryEntry[];
  photoCountHere: number;
  quickPaths: { label: string; path: string }[];
}

export type SortField = 'name' | 'date' | 'size' | 'rating';
export type SortDirection = 'asc' | 'desc';

export type RatedFilter = 'all' | 'rated' | 'unrated';
export type FormatFilter = 'all' | 'raw' | 'jpeg' | 'paired';

export interface FilterState {
  rated: RatedFilter;
  minRating: number;          // 0 = any, 1..5 = >= N
  format: FormatFilter;
  search: string;
}

export type ViewMode = 'grid' | 'loupe' | 'compare';

export interface BatchActionRequest {
  folder: string;
  itemIds: string[];
  action: 'copy' | 'move' | 'trash';
  targetFolder?: string;
  pairingEnabled: boolean;
  conflictStrategy?: 'skip' | 'rename' | 'overwrite';
}

export interface BatchActionResult {
  processedItems: number;
  processedFiles: number;
  skippedItems: number;
  errors: { itemId: string; message: string }[];
  trashDir?: string;
}

export interface IngestRequest {
  sourceFolder: string;
  targetRoot: string;
  template: string;           // e.g. "{YYYY}-{MM}-{DD}_{name}"
  shootName: string;
  includeSidecars: boolean;
}

export interface IngestResult {
  destinationFolder: string;
  copiedFiles: number;
  skippedFiles: number;
  totalBytes: number;
}

export interface MetadataPatchRequest {
  folder: string;
  itemId: string;
  rating: number;
  pairingEnabled: boolean;
}

export const RAW_EXTENSIONS = new Set([
  '.arw', '.cr2', '.cr3', '.nef', '.nrw', '.raf', '.dng',
  '.orf', '.rw2', '.pef', '.srw', '.iiq', '.3fr', '.erf',
  '.mrw', '.sr2', '.srf', '.kdc', '.dcr', '.mos', '.x3f',
]);

export const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.avif', '.gif', '.tif', '.tiff',
]);
