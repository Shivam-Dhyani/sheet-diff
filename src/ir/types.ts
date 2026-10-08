/**
 * Compact intermediate representation (IR) for a workbook (TDD §6.1).
 *
 * The IR is the only model the engine works with. It uses columnar typed
 * arrays plus an interned string pool so that large sheets stay small in
 * memory (≈ 26 MB per 2M cells, TDD §6.1 / §13).
 *
 * All coordinates are 0-based internally (TDD §1 rule 5).
 */

/** Cell kind tag stored in {@link SheetIR.kind}. */
export const CellKind = {
  Empty: 0,
  Number: 1,
  String: 2,
  Boolean: 3,
  Error: 4,
  /** A date stored as an Excel serial number (value lives in `num`). */
  DateSerial: 5,
} as const;

export type CellKind = (typeof CellKind)[keyof typeof CellKind];

/** Supported source formats. */
export type WorkbookFormat = 'xlsx' | 'xlsm' | 'xls' | 'csv';

/** A single cell resolved out of the columnar arrays. */
export interface Cell {
  kind: CellKind;
  /** Number / boolean (0|1) / date serial; `NaN` when not numeric. */
  num: number;
  /** Decoded string value (empty when not a string/error). */
  text: string;
  /** Formula text without the leading `=`, or `undefined`. */
  formula?: string;
  /** Number-format pool string, or `undefined` (only when requested). */
  numFmt?: string;
}

/** A merged-cell rectangle (0-based, inclusive bounds). */
export type MergeRange = [r1: number, c1: number, r2: number, c2: number];

/** One sheet, stored columnar + interned. */
export interface SheetIR {
  name: string;
  /** Used-range size (0-based bounds → counts). */
  rows: number;
  cols: number;
  /** `rows*cols`, row-major: the {@link CellKind} of each cell. */
  kind: Uint8Array;
  /** Numbers / booleans / date serials (`NaN` otherwise). */
  num: Float64Array;
  /** String-pool id (0 = none); also holds error text. */
  str: Uint32Array;
  /** cellIndex → formula-pool id (formula text, no leading `=`). */
  formula: Map<number, number>;
  /** cellIndex → numFmt-pool id (only if `compareNumberFormats`). */
  numFmt: Map<number, number> | null;
  /** Merged-cell rectangles. */
  merges: MergeRange[];
}

/**
 * Feature inventory for xlsx/xlsm (TDD §6.2). Built from the zip listing plus
 * light XML scans. Used by the merge fidelity checklist and the blockers.
 */
export interface FeatureInventory {
  /** Sheet names referenced by charts. */
  charts: string[];
  /** Pivot-cache worksheet sources (sheet names). */
  pivotSources: string[];
  tablesBySheet: Record<string, { name: string; ref: string }[]>;
  /** Sheet → row indices (0-based) carrying comments. */
  commentsBySheet: Record<string, number[]>;
  /** Sheet → drawing anchor rows (0-based). */
  drawingsAnchorRows: Record<string, number[]>;
  hasMacros: boolean;
  externalLinks: number;
  /** Sheets with `extLst`/x14 sqref content. */
  extLstSqrefSheets: string[];
  /** Sheet → rows (0-based) carrying array/data-table formulas. */
  arrayFormulaRows: Record<string, number[]>;
}

export function emptyFeatureInventory(): FeatureInventory {
  return {
    charts: [],
    pivotSources: [],
    tablesBySheet: {},
    commentsBySheet: {},
    drawingsAnchorRows: {},
    hasMacros: false,
    externalLinks: 0,
    extLstSqrefSheets: [],
    arrayFormulaRows: {},
  };
}

/** A whole workbook in IR form. */
export interface WorkbookIR {
  fileName: string;
  format: WorkbookFormat;
  /** Whether the 1904 date system is in effect. */
  date1904: boolean;
  /** Shared interning pool for all sheets. */
  pool: StringPool;
  sheets: SheetIR[];
  /** `docProps/core.xml` metadata (used in P2). */
  meta: { lastModifiedBy?: string; modified?: string };
  features: FeatureInventory;
  /** Kept only for the merge Original (patching). */
  sourceBytes?: Uint8Array;
}

/**
 * A read-only interning pool. Id 0 is reserved for "no string". Ids are stable
 * within a single pool instance.
 */
export interface StringPool {
  /** Intern a string → id (0 for the empty sentinel is never returned here). */
  intern(s: string): number;
  /** Resolve an id → string (id 0 → ''). */
  get(id: number): string;
  /** Number of interned strings (excluding the id-0 sentinel). */
  readonly size: number;
}
