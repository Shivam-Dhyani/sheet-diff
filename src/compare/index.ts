import { CellKind, type SheetIR, type StringPool, type WorkbookIR } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import type {
  CompareResult,
  SheetPairResult,
  Counts,
  CellChange,
  ColumnMatch,
  KeyInfo,
} from '../types.js';
import { RowState } from '../types.js';
import { resolveCompareOptions, type CompareOptions, DEFAULT_CHECK_OPTIONS, type CheckOptions } from '../options.js';
import type { TableModel } from '../table/index.js';
import { matchRowsByKey } from '../match/rows-key.js';
import { matchRowsByOrder } from '../match/rows-order.js';
import type { TranslateContext } from '../formula/translate.js';
import { compareCells, type ColumnPair, type RowPair } from './cells.js';
import { positionalBaseline } from './positional.js';
import { preparePairs, numericColumns, type PreparedPair } from './prepare.js';
import type { CheckContext, CheckPair } from '../checks/context.js';
import { runChecksWithContext } from '../checks/index.js';

export type { PreparedPair } from './prepare.js';
export { pairId } from './prepare.js';

/** Lightweight analysis for the Setup UI (sheet pairs, keys, columns). */
export interface PairSetup {
  id: string;
  status: SheetPairResult['status'];
  oldName?: string;
  newName?: string;
  key: KeyInfo;
  columns: ColumnMatch[];
  confidence: KeyInfo['confidence'];
  headerRowOld?: number;
  headerRowNew?: number;
}

export interface PairAnalysis {
  pairs: PairSetup[];
}

export function analyzePair(
  oldWb: WorkbookIR,
  newWb: WorkbookIR,
  opts?: Partial<CompareOptions>,
): PairAnalysis {
  const options = resolveCompareOptions(opts);
  const prepared = preparePairs(oldWb, newWb, options);
  return {
    pairs: prepared.map((p) => ({
      id: p.id,
      status: p.status,
      ...(p.oldName !== undefined ? { oldName: p.oldName } : {}),
      ...(p.newName !== undefined ? { newName: p.newName } : {}),
      key: p.key?.info ?? { columns: [], mode: 'order', confidence: 'low', duplicates: 0 },
      columns: p.columnMatch?.matches ?? [],
      confidence: p.key?.info.confidence ?? 'low',
      ...(p.oldTable ? { headerRowOld: p.oldTable.headerRow } : {}),
      ...(p.newTable ? { headerRowNew: p.newTable.headerRow } : {}),
    })),
  };
}

export interface CoreResult {
  result: Omit<CompareResult, 'findings'>;
  checkContext: CheckContext;
}

function buildRowMap(
  oldTable: TableModel,
  newTable: TableModel,
  rowPairs: RowPair[],
  removed: number[],
  oldRows: number,
): Map<number, number> {
  const map = new Map<number, number>();
  const aboveOffset = newTable.dataStart - oldTable.dataStart;
  const belowDelta = newTable.dataEnd - oldTable.dataEnd;
  for (let r = 0; r < oldRows; r++) {
    if (r < oldTable.dataStart) map.set(r, Math.max(0, r + aboveOffset));
    else if (r > oldTable.dataEnd) map.set(r, r + belowDelta);
    else map.set(r, -1);
  }
  for (const r of removed) map.set(r, -1);
  for (const p of rowPairs) map.set(p.oldRow, p.newRow);
  return map;
}

function buildColMap(oldToNew: Map<number, number>, oldCols: number): Map<number, number> {
  const map = new Map<number, number>();
  for (let c = 0; c < oldCols; c++) map.set(c, oldToNew.get(c) ?? c);
  return map;
}

function displayKey(sheet: SheetIR, pool: StringPool, cols: number[], row: number): string {
  if (cols.length === 0) return '';
  const parts: string[] = [];
  for (const c of cols) {
    const cell = getCell(sheet, pool, row, c);
    parts.push(cell.kind === CellKind.String || cell.kind === CellKind.Error ? cell.text : String(cell.num));
  }
  return parts.join(' / ');
}

export function compareCore(oldWb: WorkbookIR, newWb: WorkbookIR, options: CompareOptions): CoreResult {
  const start = Date.now();
  const prepared = preparePairs(oldWb, newWb, options);

  // Phase 1: row matching + full row/col maps (needed before cross-sheet formula translation).
  const rowMaps = new Map<string, Map<number, number>>(); // keyed by OLD sheet name
  const colMaps = new Map<string, Map<number, number>>();
  const oldByName = new Map(oldWb.sheets.map((s) => [s.name, s]));

  interface Phase1 {
    prep: PreparedPair;
    oldSheet: SheetIR;
    newSheet: SheetIR;
    rowPairs: RowPair[];
    removed: number[];
    added: number[];
    moved: Set<number>;
    changedByOrder: Set<number>;
  }
  const phase1: Phase1[] = [];

  for (const prep of prepared) {
    if (prep.status === 'added' || prep.status === 'removed') continue;
    const oldSheet = oldWb.sheets[prep.oldIndex!]!;
    const newSheet = newWb.sheets[prep.newIndex!]!;
    const oldTable = prep.oldTable!;
    const newTable = prep.newTable!;
    const key = prep.key!;

    let rowPairs: RowPair[] = [];
    let removed: number[] = [];
    let added: number[] = [];
    const moved = new Set<number>();
    const changedByOrder = new Set<number>();

    if (key.info.mode === 'order') {
      const cm = prep.columnMatch!;
      const colsOld = cm.common.map((c) => c.oldIndex);
      const colsNew = cm.common.map((c) => c.newIndex);
      const m = matchRowsByOrder(oldSheet, newSheet, oldTable, newTable, { old: colsOld, new: colsNew }, oldWb.pool, newWb.pool, options);
      rowPairs = m.pairs.map((p) => ({ oldRow: p.oldRow, newRow: p.newRow }));
      removed = m.removed;
      added = m.added;
      for (const p of m.pairs) {
        if (p.moved) moved.add(p.newRow);
        if (p.changed) changedByOrder.add(p.newRow);
      }
    } else {
      const m = matchRowsByKey(oldSheet, newSheet, oldTable, newTable, key.oldCols, key.newCols, oldWb.pool, newWb.pool, options);
      rowPairs = m.pairs;
      removed = m.removed;
      added = m.added;
    }

    rowMaps.set(oldSheet.name, buildRowMap(oldTable, newTable, rowPairs, removed, oldSheet.rows));
    colMaps.set(oldSheet.name, buildColMap(prep.columnMatch!.oldToNew, oldSheet.cols));
    phase1.push({ prep, oldSheet, newSheet, rowPairs, removed, added, moved, changedByOrder });
  }

  const translateCtxFor = (defaultSheet: string): TranslateContext => ({
    defaultSheet,
    rowMap: (sheet, r) => rowMaps.get(sheet)?.get(r) ?? r,
    colMap: (sheet, c) => colMaps.get(sheet)?.get(c) ?? c,
    rowCount: (sheet) => oldByName.get(sheet)?.rows ?? 0,
    colCount: (sheet) => oldByName.get(sheet)?.cols ?? 0,
  });

  // Phase 2: cell comparison + result assembly.
  const pairs: SheetPairResult[] = [];
  const checkPairs: CheckPair[] = [];
  const positional: Record<string, number> = {};

  for (const prep of prepared) {
    if (prep.status === 'added' || prep.status === 'removed') {
      const empty: SheetPairResult = {
        id: prep.id,
        ...(prep.oldName !== undefined ? { oldName: prep.oldName } : {}),
        ...(prep.newName !== undefined ? { newName: prep.newName } : {}),
        status: prep.status,
        key: { columns: [], mode: 'order', confidence: 'low', duplicates: 0 },
        columns: [],
        rowMap: new Int32Array(0),
        rowStatus: new Uint8Array(0),
        cellChanges: [],
      };
      pairs.push(empty);
      checkPairs.push({ id: prep.id, status: prep.status, result: empty });
      continue;
    }

    const ph = phase1.find((x) => x.prep.id === prep.id)!;
    const { oldSheet, newSheet } = ph;
    const oldTable = prep.oldTable!;
    const newTable = prep.newTable!;
    const key = prep.key!;
    const columns: ColumnPair[] = prep.columnMatch!.common.map((c) => ({
      oldCol: c.oldIndex,
      newCol: c.newIndex,
      header: c.header,
    }));
    const numericNewCols = numericColumns(newSheet, newWb.pool, newTable);
    const translateCtx = translateCtxFor(oldSheet.name);

    const keyOf = (sheet: SheetIR, row: number): string =>
      sheet === newSheet
        ? displayKey(newSheet, newWb.pool, key.newCols, row)
        : displayKey(oldSheet, oldWb.pool, key.oldCols, row);

    const cellResult = compareCells({
      pairId: prep.id,
      oldSheet,
      newSheet,
      oldSheetName: oldSheet.name,
      newSheetName: newSheet.name,
      date1904Old: oldWb.date1904,
      date1904New: newWb.date1904,
      columns,
      rows: ph.rowPairs,
      numericNewCols,
      oldPool: oldWb.pool,
      newPool: newWb.pool,
      opts: options,
      translateCtx,
      keyOf,
    });

    // rowMap (old data rows → new absolute row or −1).
    const oldDataRows = Math.max(0, oldTable.dataEnd - oldTable.dataStart + 1);
    const rowMapArr = new Int32Array(oldDataRows).fill(-1);
    const fullMap = rowMaps.get(oldSheet.name)!;
    for (let i = 0; i < oldDataRows; i++) {
      rowMapArr[i] = fullMap.get(oldTable.dataStart + i) ?? -1;
    }

    // rowStatus (new data rows).
    const newDataRows = Math.max(0, newTable.dataEnd - newTable.dataStart + 1);
    const rowStatus = new Uint8Array(newDataRows).fill(RowState.Unchanged);
    for (const [newRow, state] of cellResult.rowState) {
      const i = newRow - newTable.dataStart;
      if (i >= 0 && i < newDataRows) rowStatus[i] = state;
    }
    for (const r of ph.added) {
      const i = r - newTable.dataStart;
      if (i >= 0 && i < newDataRows) rowStatus[i] = RowState.Added;
    }
    for (const r of ph.moved) {
      const i = r - newTable.dataStart;
      if (i >= 0 && i < newDataRows && rowStatus[i] === RowState.Unchanged) rowStatus[i] = RowState.Moved;
    }

    const result: SheetPairResult = {
      id: prep.id,
      oldName: oldSheet.name,
      newName: newSheet.name,
      status: prep.status,
      key: key.info,
      columns: prep.columnMatch!.matches,
      rowMap: rowMapArr,
      rowStatus,
      cellChanges: sortChanges(cellResult.changes, newTable),
    };
    // Expose added/removed counts via a side map on the result's data for checks.
    pairs.push(result);
    positional[prep.id] = positionalBaseline(
      oldSheet,
      newSheet,
      oldWb.pool,
      newWb.pool,
      oldWb.date1904,
      newWb.date1904,
      options,
      Math.min(oldTable.dataStart, newTable.dataStart),
      Math.max(oldTable.dataEnd, newTable.dataEnd),
    );

    checkPairs.push({
      id: prep.id,
      status: prep.status,
      result,
      oldSheet,
      newSheet,
      oldTable,
      newTable,
      oldKeyCols: key.oldCols,
      newKeyCols: key.newCols,
      columns,
      translateCtx,
      added: ph.added,
      removed: ph.removed,
      moved: [...ph.moved],
    });
  }

  const counts = countChanges(pairs, checkPairs);

  const result: Omit<CompareResult, 'findings'> = {
    pairs,
    counts,
    positionalBaseline: positional,
    durationMs: Date.now() - start,
  };

  const checkContext: CheckContext = {
    oldWb,
    newWb,
    opts: options,
    checkOpts: DEFAULT_CHECK_OPTIONS,
    pairs: checkPairs,
  };

  return { result, checkContext };
}

function sortChanges(changes: CellChange[], _newTable: TableModel): CellChange[] {
  return [...changes].sort(
    (a, b) =>
      (a.newCell?.r ?? 0) - (b.newCell?.r ?? 0) ||
      (a.newCell?.c ?? 0) - (b.newCell?.c ?? 0) ||
      a.column.localeCompare(b.column),
  );
}

function countChanges(pairs: SheetPairResult[], checkPairs: CheckPair[]): Counts {
  let rowsAdded = 0;
  let rowsRemoved = 0;
  let cellsEditedByHand = 0;
  let formulasOverwritten = 0;
  let recalculated = 0;
  let valueOrType = 0;
  let formulaChanges = 0;

  for (const cp of checkPairs) {
    rowsAdded += cp.added?.length ?? 0;
    rowsRemoved += cp.removed?.length ?? 0;
  }
  for (const p of pairs) {
    for (const ch of p.cellChanges) {
      switch (ch.kind) {
        case 'value_changed':
        case 'type_changed':
          cellsEditedByHand++;
          valueOrType++;
          break;
        case 'formula_overwritten':
          formulasOverwritten++;
          formulaChanges++;
          break;
        case 'formula_changed':
        case 'formula_added':
          formulaChanges++;
          break;
        case 'recalculated':
          recalculated++;
          break;
        default:
          break;
      }
    }
  }

  const realChanges = valueOrType + formulaChanges + rowsAdded + rowsRemoved;
  return {
    needsAttention: 0, // filled after checks
    toReview: 0,
    rowsAdded,
    rowsRemoved,
    cellsEditedByHand,
    formulasOverwritten,
    realChanges,
    recalculated,
  };
}

/** Full comparison (TDD §6.3). Runs checks and returns the complete result. */
export function compareWorkbooks(
  oldWb: WorkbookIR,
  newWb: WorkbookIR,
  opts?: Partial<CompareOptions>,
  checkOpts?: Partial<CheckOptions>,
): CompareResult {
  const options = resolveCompareOptions(opts);
  const { result, checkContext } = compareCore(oldWb, newWb, options);
  if (checkOpts) checkContext.checkOpts = { ...checkContext.checkOpts, ...checkOpts };
  const findings = runChecksWithContext(checkContext);
  const needsAttention = findings.filter((f) => f.severity === 'high').length;
  const toReview = findings.filter((f) => f.severity === 'medium').length;
  return {
    ...result,
    counts: { ...result.counts, needsAttention, toReview },
    findings,
  };
}

/**
 * Re-run checks for a pair of workbooks (TDD §6.3). The context is rebuilt from
 * the IRs; the passed result is accepted for API symmetry but not required.
 */
export function runChecks(
  _result: CompareResult | null,
  oldWb: WorkbookIR,
  newWb: WorkbookIR,
  opts?: Partial<CompareOptions>,
  checkOpts?: Partial<CheckOptions>,
): CompareResult['findings'] {
  const { checkContext } = compareCore(oldWb, newWb, resolveCompareOptions(opts));
  if (checkOpts) checkContext.checkOpts = { ...checkContext.checkOpts, ...checkOpts };
  return runChecksWithContext(checkContext);
}
