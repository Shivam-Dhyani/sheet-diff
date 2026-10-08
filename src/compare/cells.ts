import { CellKind, type Cell, type SheetIR, type StringPool } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import { rcToA1 } from '../ir/coords.js';
import type { CellChange, ChangeKind, Flag, Scalar, RowState } from '../types.js';
import { RowState as RS } from '../types.js';
import type { CompareOptions } from '../options.js';
import { compareValues, numericValue, parseNumericText } from './normalize.js';
import { formulasEquivalent, type TranslateContext } from '../formula/translate.js';

export interface ColumnPair {
  oldCol: number;
  newCol: number;
  header: string;
}

export interface RowPair {
  oldRow: number;
  newRow: number;
}

export interface CellCompareInput {
  pairId: string;
  oldSheet: SheetIR;
  newSheet: SheetIR;
  oldSheetName: string;
  newSheetName: string;
  date1904Old: boolean;
  date1904New: boolean;
  columns: ColumnPair[];
  rows: RowPair[];
  /** new-side column indices whose data is numeric-dominant (for CHK-06 flag). */
  numericNewCols: Set<number>;
  oldPool: StringPool;
  newPool: StringPool;
  opts: CompareOptions;
  translateCtx: TranslateContext;
  keyOf: (sheet: SheetIR, row: number) => string;
}

export interface CellCompareResult {
  changes: CellChange[];
  /** new row index → row state (changed/unchanged). */
  rowState: Map<number, RowState>;
}

function scalarFromCell(cell: Cell): Scalar {
  switch (cell.kind) {
    case CellKind.Empty:
      return null;
    case CellKind.Number:
    case CellKind.DateSerial:
      return cell.num;
    case CellKind.Boolean:
      return cell.num !== 0;
    case CellKind.Error:
    case CellKind.String:
    default:
      return cell.text;
  }
}

/** Compare matched row pairs cell by cell (TDD §7.7). */
export function compareCells(input: CellCompareInput): CellCompareResult {
  const changes: CellChange[] = [];
  const rowState = new Map<number, RowState>();

  for (const rp of input.rows) {
    let rowChanged = false;
    const key = input.keyOf(input.newSheet, rp.newRow) || input.keyOf(input.oldSheet, rp.oldRow);

    for (const col of input.columns) {
      const oldCell = getCell(input.oldSheet, input.oldPool, rp.oldRow, col.oldCol);
      const newCell = getCell(input.newSheet, input.newPool, rp.newRow, col.newCol);
      const change = classify(oldCell, newCell, input, col, rp, key);
      if (!change) continue;
      changes.push(change);
      if (change.kind !== 'recalculated' && change.kind !== 'format_changed') rowChanged = true;
    }
    rowState.set(rp.newRow, rowChanged ? RS.Changed : RS.Unchanged);
  }

  return { changes, rowState };
}

function classify(
  oldCell: Cell,
  newCell: Cell,
  input: CellCompareInput,
  col: ColumnPair,
  rp: RowPair,
  key: string,
): CellChange | null {
  const { opts } = input;
  const base = {
    pairId: input.pairId,
    key,
    column: col.header,
    oldCell: { sheet: input.oldSheetName, ref: rcToA1(rp.oldRow, col.oldCol), r: rp.oldRow, c: col.oldCol },
    newCell: { sheet: input.newSheetName, ref: rcToA1(rp.newRow, col.newCol), r: rp.newRow, c: col.newCol },
    old: scalarFromCell(oldCell),
    new: scalarFromCell(newCell),
  };

  let kind: ChangeKind | null = null;

  if (oldCell.formula !== undefined && newCell.formula !== undefined) {
    const equiv = formulasEquivalent(oldCell.formula, newCell.formula, input.translateCtx);
    if (equiv) {
      const eq = compareValues(oldCell, newCell, input.date1904Old, input.date1904New, opts) === 'equal';
      kind = eq ? null : 'recalculated';
    } else {
      kind = 'formula_changed';
    }
  } else if (oldCell.formula !== undefined && newCell.formula === undefined) {
    kind = 'formula_overwritten';
  } else if (oldCell.formula === undefined && newCell.formula !== undefined) {
    kind = 'formula_added';
  } else {
    const eq = compareValues(oldCell, newCell, input.date1904Old, input.date1904New, opts);
    if (eq === 'equal') kind = null;
    else if (eq === 'type_changed') kind = 'type_changed';
    else kind = 'value_changed';
  }

  // number-format change (Info) layered on top when enabled and no other change.
  if (kind === null && opts.compareNumberFormats && oldCell.numFmt !== newCell.numFmt) {
    kind = 'format_changed';
  }

  if (kind === null) return null;

  const flags = computeFlags(oldCell, newCell, input, col, kind);
  const change: CellChange = { ...base, kind, flags };
  if (oldCell.formula !== undefined) change.oldFormula = oldCell.formula;
  if (newCell.formula !== undefined) change.newFormula = newCell.formula;
  return change;
}

function computeFlags(
  oldCell: Cell,
  newCell: Cell,
  input: CellCompareInput,
  col: ColumnPair,
  kind: ChangeKind,
): Flag[] {
  const flags: Flag[] = [];

  // CHK-06 flag: a number stored as text in a numeric column (changed/added cells).
  if (
    input.numericNewCols.has(col.newCol) &&
    newCell.kind === CellKind.String &&
    parseNumericText(newCell.text) !== null
  ) {
    flags.push('number_as_text');
  }

  // CHK-08 flag: a numeric input changed by ≥ 50% or flipped sign.
  const isInput = oldCell.formula === undefined && newCell.formula === undefined;
  if (isInput && (kind === 'value_changed' || kind === 'type_changed')) {
    const a = numericValue(oldCell) ?? parseNumericText(oldCell.text);
    const b = numericValue(newCell) ?? parseNumericText(newCell.text);
    if (a !== null && b !== null && a !== 0) {
      const ratio = Math.abs(b - a) / Math.abs(a);
      const signFlip = Math.sign(a) !== 0 && Math.sign(b) !== 0 && Math.sign(a) !== Math.sign(b);
      if (ratio >= 0.5 || signFlip) flags.push('large_change');
    }
  }

  return flags;
}
