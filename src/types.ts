/** Public comparison result model (TDD §6.3). */

/** A scalar cell value as surfaced to consumers. */
export type Scalar = number | string | boolean | null;

/** Cell-level change kinds (FR-CMP-02, TDD §7.7). */
export type ChangeKind =
  | 'value_changed'
  | 'formula_changed'
  | 'formula_overwritten'
  | 'formula_added'
  | 'type_changed'
  | 'format_changed'
  | 'recalculated';

/** Per-change flags. */
export type Flag = 'large_change' | 'number_as_text' | 'invalid_id';

/** Row states (FR-CMP-01). Stored numerically in `rowStatus`. */
export const RowState = {
  Unchanged: 0,
  Changed: 1,
  Added: 2,
  Removed: 3,
  Moved: 4,
} as const;
export type RowState = (typeof RowState)[keyof typeof RowState];

/** A1-ish cell reference for the UI/detail panel. */
export interface CellRef {
  sheet: string;
  /** A1 address, e.g. "H12". */
  ref: string;
  r: number;
  c: number;
}

export interface CellChange {
  pairId: string;
  key: string;
  column: string;
  kind: ChangeKind;
  oldCell?: CellRef;
  newCell?: CellRef;
  old: Scalar;
  new: Scalar;
  oldFormula?: string;
  newFormula?: string;
  flags: Flag[];
}

export type KeyMode = 'key' | 'composite' | 'order';
export type Confidence = 'high' | 'medium' | 'low';

export interface KeyInfo {
  columns: string[];
  mode: KeyMode;
  confidence: Confidence;
  /** Number of duplicate key values (BR-C2 / CHK-07 input). */
  duplicates: number;
}

export type ColumnStatus = 'matched' | 'renamed' | 'added' | 'removed';

export interface ColumnMatch {
  oldName?: string;
  newName?: string;
  oldIndex?: number;
  newIndex?: number;
  status: ColumnStatus;
}

export interface TotalsRowChange {
  label: string;
  column: string;
  old: Scalar;
  new: Scalar;
  kind: ChangeKind;
}

export interface TotalsSection {
  rows: TotalsRowChange[];
}

export type PairStatus = 'matched' | 'renamed' | 'added' | 'removed';

export interface SheetPairResult {
  id: string;
  oldName?: string;
  newName?: string;
  status: PairStatus;
  key: KeyInfo;
  columns: ColumnMatch[];
  /** old data-row index → new data-row index, or -1 if removed. */
  rowMap: Int32Array;
  /** Per new-and-removed-row state (see {@link RowState}). */
  rowStatus: Uint8Array;
  cellChanges: CellChange[];
  totalsSection?: TotalsSection;
}

export type Severity = 'high' | 'medium' | 'info';

export type CheckRule =
  | 'CHK-01'
  | 'CHK-02'
  | 'CHK-03'
  | 'CHK-04'
  | 'CHK-05'
  | 'CHK-06'
  | 'CHK-07'
  | 'CHK-08'
  | 'CHK-09'
  | 'CHK-10'
  | 'ROW_ADDED'
  | 'ROW_REMOVED'
  | 'CELL_EDIT'
  | 'RECALCULATED';

export interface Finding {
  id: string;
  rule: CheckRule;
  severity: Severity;
  pairId?: string;
  key?: string;
  column?: string;
  cells?: string[];
  title: string;
  message: string;
  data: Record<string, unknown>;
}

export interface Counts {
  needsAttention: number;
  toReview: number;
  rowsAdded: number;
  rowsRemoved: number;
  cellsEditedByHand: number;
  formulasOverwritten: number;
  /** "Real changes" per BR-C7. */
  realChanges: number;
  recalculated: number;
}

export interface CompareResult {
  pairs: SheetPairResult[];
  findings: Finding[];
  counts: Counts;
  /** pairId → count of cells differing at the same address (FR-RES-01). */
  positionalBaseline: Record<string, number>;
  durationMs: number;
}
