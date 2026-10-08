/** Report data model (TDD §6.3 / FR-REP-01). Rendering lives in the app. */
import type { Scalar, Severity, Counts, Finding, RowState } from '../types.js';

export interface ReportMeta {
  oldFile: string;
  newFile: string;
  /** e.g. "Invoice No (auto-detected: unique in both files)". */
  matchedBy: string;
  generated: string; // ISO date
}

export interface ReportOverview {
  counts: Counts;
  /** Info-severity finding count ("For information"). */
  forInformation: number;
  /** Positional baseline total — "a basic compare would flag N cells". */
  contrastCells: number;
  /** The High findings, for the attention list. */
  attention: Finding[];
}

export interface ReportChange {
  index: number;
  risk: Severity;
  where: string; // sheet / location
  key: string;
  column: string;
  whatChanged: string; // the finding title
  old: Scalar;
  new: Scalar;
  meaning: string; // the finding message
  rule: Finding['rule'];
}

export interface MarkedCell {
  value: Scalar;
  changed: boolean;
  high: boolean;
  recalculated: boolean;
  /** Present when `changed` — the pre-change value. */
  oldValue?: Scalar;
}

export interface MarkedRow {
  status: RowState;
  key: string;
  cells: MarkedCell[];
}

export interface RemovedRow {
  key: string;
  /** Key of the preceding surviving row (null = top), so the app can place it. */
  afterKey: string | null;
  cells: Scalar[];
}

export interface MarkedSheet {
  name: string;
  columns: string[];
  rows: MarkedRow[];
  removed: RemovedRow[];
}

export interface ReportModel {
  meta: ReportMeta;
  overview: ReportOverview;
  allChanges: ReportChange[];
  markedSheets: MarkedSheet[];
}
