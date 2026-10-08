/** Assisted three-way merge model (TDD §9, business rules BR-M1..M9). */
import type { Scalar } from '../types.js';

/** Which input a change came from. A = copy 1, B = copy 2. */
export type MergeSource = 'A' | 'B' | 'both' | 'typed';

export type ConflictType = 'CELL' | 'RELATED_EDITS' | 'DELETE_EDIT' | 'ADD_ADD' | 'STRUCTURE';

export interface CellEdit {
  column: string;
  base: Scalar;
  value: Scalar;
  formula?: string;
}

/** An inserted row's cell contents. */
export interface RowCell {
  column: string;
  value?: Scalar;
  formula?: string;
}

export type ProposalKind = 'cell' | 'row_add' | 'row_delete';

export interface Proposal {
  id: string;
  kind: ProposalKind;
  sheet: string;
  key: string;
  source: MergeSource;
  /** Pre-ticked by default (BR-M2); the user can untick. */
  selected: boolean;
  // cell
  column?: string;
  base?: Scalar;
  value?: Scalar;
  formula?: string;
  // row_add
  afterKey?: string | null;
  cells?: RowCell[];
  /** 0-based source row in the copy (for formula re-anchoring). */
  sourceRow?: number;
}

export interface Conflict {
  id: string;
  type: ConflictType;
  sheet: string;
  key?: string;
  // CELL
  column?: string;
  base?: Scalar;
  aValue?: Scalar;
  bValue?: Scalar;
  // RELATED_EDITS
  aEdits?: CellEdit[];
  bEdits?: CellEdit[];
  why?: string;
  // DELETE_EDIT
  deletedBy?: MergeSource;
  editedBy?: MergeSource;
  edits?: CellEdit[];
  // ADD_ADD
  aCells?: RowCell[];
  bCells?: RowCell[];
  afterKey?: string | null;
}

export interface StructureDiff {
  kind: 'sheet_added' | 'sheet_removed' | 'column_added' | 'column_removed';
  source: MergeSource;
  sheet?: string;
  column?: string;
}

export interface MergePlan {
  labels: [string, string];
  keyColumns: string[];
  proposals: Proposal[];
  conflicts: Conflict[];
  structure: StructureDiff[];
}

/* ── Resolutions ───────────────────────────────────────────── */

export type CellResolution = 'A' | 'B' | 'base' | { typed: Scalar };
export type RelatedResolution = 'A' | 'B' | 'base' | 'both';
export type DeleteEditResolution = 'delete' | 'keepEdits' | 'base';
export type AddAddResolution = 'A' | 'B' | 'both';
export type ConflictResolution =
  | CellResolution
  | RelatedResolution
  | DeleteEditResolution
  | AddAddResolution;

export interface Resolutions {
  /** conflictId → chosen resolution. Every conflict must be resolved. */
  conflicts: Record<string, ConflictResolution>;
  /** proposal ids the user turned off. */
  untickedProposals?: string[];
  /** conflictId → acknowledged "accept both" for RELATED_EDITS (BR-M4). */
  acknowledgeRelated?: Record<string, boolean>;
}

/* ── Change set (TDD §9.2) ─────────────────────────────────── */

export interface ChangeSetCellEdit {
  sheet: string;
  key: string;
  column: string;
  value?: Scalar;
  formula?: string;
  source: MergeSource;
}
export interface ChangeSetRowInsert {
  sheet: string;
  key: string;
  afterKey: string | null;
  cells: RowCell[];
  source: MergeSource;
  /** 0-based source row in the originating copy (for formula re-anchoring). */
  sourceRow?: number;
}
export interface ChangeSetRowDelete {
  sheet: string;
  key: string;
  source: MergeSource;
}
export interface ChangeSetExtendRange {
  sheet: string;
  cell: string;
  from: string;
  to: string;
}
export interface MergeChangeSet {
  cellEdits: ChangeSetCellEdit[];
  rowInserts: ChangeSetRowInsert[];
  rowDeletes: ChangeSetRowDelete[];
  extendRanges: ChangeSetExtendRange[];
}

/* ── Impact preview (TDD §9.3) ─────────────────────────────── */

export interface ImpactRow {
  sheet: string;
  label: string;
  cell: string;
  before: number | null;
  after: number | 'excel';
}

/* ── Merge log (TDD §9.4) ──────────────────────────────────── */

export interface MergeLogRow {
  n: number;
  sheet: string;
  key: string;
  column: string;
  oldValue: Scalar;
  newValue: Scalar;
  source: string;
  decision: string;
  note: string;
}
