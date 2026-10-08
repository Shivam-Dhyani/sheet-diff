/** Options surface for reading, comparing and checking (TDD §6.3). */

export type DateOrder = 'DMY' | 'MDY' | 'YMD';

/** Manual override of automatic sheet pairing. */
export interface SheetPairOverride {
  oldName?: string;
  newName?: string;
  /** Explicitly exclude this pairing from comparison. */
  exclude?: boolean;
}

export interface CompareOptions {
  /** Manual sheet-pairing overrides (otherwise auto). */
  sheetPairs?: SheetPairOverride[];
  /** pairId → 0-based header row override. */
  headerRow?: Record<string, number>;
  /** pairId → `{ start, end }` 0-based inclusive data-row override. */
  dataRange?: Record<string, { start: number; end: number }>;
  /** pairId → key column header names (single or composite). */
  keys?: Record<string, string[]>;
  ignoreCase: boolean;
  ignoreSpaces: boolean;
  /** Numbers within this absolute tolerance are equal (BR-C4). */
  numericTolerance: number;
  /** Treat a text date and the same real date as equal (BR-C5). */
  textDatesEqual: boolean;
  /** Compare number formats (default off). */
  compareNumberFormats: boolean;
  dateOrder: DateOrder;
}

export const DEFAULT_COMPARE_OPTIONS: CompareOptions = {
  ignoreCase: false,
  ignoreSpaces: false,
  numericTolerance: 0.01,
  textDatesEqual: true,
  compareNumberFormats: false,
  dateOrder: 'DMY',
};

export function resolveCompareOptions(opts?: Partial<CompareOptions>): CompareOptions {
  return { ...DEFAULT_COMPARE_OPTIONS, ...(opts ?? {}) };
}

export interface CheckOptions {
  /** Enable the India pack (GSTIN/PAN) checks (CHK-10). Default true. */
  indiaPack: boolean;
}

export const DEFAULT_CHECK_OPTIONS: CheckOptions = {
  indiaPack: true,
};

/** Progress event emitted while reading. */
export interface Progress {
  phase: 'read' | 'decrypt' | 'parse' | 'features';
  /** Human-readable, e.g. "Reading sheet 2 of 5…". */
  message: string;
  /** 0..1 when known. */
  fraction?: number;
}

/** Cooperative abort signal (a plain object so it works across the worker boundary). */
export interface AbortFlag {
  aborted: boolean;
}

export interface ReadOptions {
  fileName: string;
  password?: string;
  csv?: { delimiter?: string; encoding?: 'utf-8' | 'windows-1252' };
  /** Skip formulas and number formats (recovery path after OOM). */
  valuesOnly?: boolean;
  /** Keep raw bytes on the IR (needed only for the merge Original). */
  keepSourceBytes?: boolean;
  onProgress?: (p: Progress) => void;
  signal?: AbortFlag;
}
