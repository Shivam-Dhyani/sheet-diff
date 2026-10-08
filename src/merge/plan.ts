import type { WorkbookIR } from '../ir/types.js';
import type { Scalar } from '../types.js';
import type { CompareOptions } from '../options.js';
import { SheetDiffError } from '../errors.js';
import { mergeDiff, type MergePairDiff, type MergeEdit, type MergeAdded } from './diff.js';
import type { Proposal, Conflict, MergePlan, StructureDiff, CellEdit, RowCell } from './types.js';

export interface MergeOptions extends Partial<CompareOptions> {
  labels?: [string, string];
}

function editsByKey(diff: MergePairDiff): Map<string, MergeEdit[]> {
  const m = new Map<string, MergeEdit[]>();
  for (const e of diff.edits) (m.get(e.key) ?? m.set(e.key, []).get(e.key)!).push(e);
  return m;
}
function addedByKey(diff: MergePairDiff): Map<string, MergeAdded> {
  return new Map(diff.added.map((a) => [a.key, a]));
}

function scalarEq(a: Scalar, b: Scalar): boolean {
  return a === b;
}

function sameCells(a: RowCell[], b: RowCell[]): boolean {
  if (a.length !== b.length) return false;
  const bByCol = new Map(b.map((c) => [c.column, c]));
  for (const c of a) {
    const o = bByCol.get(c.column);
    if (!o) return false;
    if ((c.formula ?? '') !== (o.formula ?? '') || !scalarEq(c.value ?? null, o.value ?? null)) return false;
  }
  return true;
}

/**
 * Plan an assisted three-way merge (TDD §9.1). Compares each copy to the base
 * with the base's key and classifies every key into auto-proposals or
 * conflicts. A merge needs a key column (BR-M9).
 */
export function planMerge(
  base: WorkbookIR,
  a: WorkbookIR,
  b: WorkbookIR,
  opts?: MergeOptions,
): MergePlan {
  const labels: [string, string] = opts?.labels ?? ['Copy 1', 'Copy 2'];
  const diffA = mergeDiff(base, a, opts);
  const diffB = mergeDiff(base, b, opts);
  const diffBBySheet = new Map(diffB.map((d) => [d.sheetName, d]));

  const proposals: Proposal[] = [];
  const conflicts: Conflict[] = [];
  const structure: StructureDiff[] = [];
  let keyColumns: string[] = [];

  // Sheet-level structure differences (BR-M7).
  for (const d of diffA) {
    if (d.status === 'added') structure.push({ kind: 'sheet_added', source: 'A', sheet: d.sheetName });
    if (d.status === 'removed') structure.push({ kind: 'sheet_removed', source: 'A', sheet: d.sheetName });
  }
  for (const d of diffB) {
    if (d.status === 'added') structure.push({ kind: 'sheet_added', source: 'B', sheet: d.sheetName });
    if (d.status === 'removed') structure.push({ kind: 'sheet_removed', source: 'B', sheet: d.sheetName });
  }

  for (const da of diffA) {
    if (da.status !== 'matched' && da.status !== 'renamed') continue;
    const db = diffBBySheet.get(da.sheetName);
    if (!db) continue;
    if (da.mode === 'order' || db.mode === 'order') {
      throw new SheetDiffError('MERGE_NO_KEY', `Sheet "${da.sheetName}" has no key column for merge.`, {
        sheet: da.sheetName,
      });
    }
    if (keyColumns.length === 0) keyColumns = da.keyColumns;

    classifySheet(da, db, labels, proposals, conflicts);
  }

  return { labels, keyColumns, proposals, conflicts, structure };
}

function classifySheet(
  da: MergePairDiff,
  db: MergePairDiff,
  labels: [string, string],
  proposals: Proposal[],
  conflicts: Conflict[],
): void {
  const sheet = da.sheetName;
  const editsA = editsByKey(da);
  const editsB = editsByKey(db);
  const addedA = addedByKey(da);
  const addedB = addedByKey(db);
  const removedA = new Set(da.removed);
  const removedB = new Set(db.removed);
  const baseKeys = new Set(da.baseKeys);

  const universe = new Set<string>([...baseKeys, ...addedA.keys(), ...addedB.keys()]);

  for (const key of universe) {
    const baseHas = baseKeys.has(key);
    const aHas = baseHas ? !removedA.has(key) : addedA.has(key);
    const bHas = baseHas ? !removedB.has(key) : addedB.has(key);
    const dA = editsA.get(key) ?? [];
    const dB = editsB.get(key) ?? [];

    if (baseHas && aHas && bHas) {
      classifyBothPresent(sheet, key, dA, dB, proposals, conflicts);
    } else if (baseHas && !aHas && bHas) {
      deleteVsEdit(sheet, key, 'A', 'B', dB, proposals, conflicts);
    } else if (baseHas && aHas && !bHas) {
      deleteVsEdit(sheet, key, 'B', 'A', dA, proposals, conflicts);
    } else if (baseHas && !aHas && !bHas) {
      proposals.push(rowDelete(sheet, key, 'both'));
    } else if (!baseHas && aHas && !bHas) {
      proposals.push(rowAdd(sheet, addedA.get(key)!, 'A'));
    } else if (!baseHas && !aHas && bHas) {
      proposals.push(rowAdd(sheet, addedB.get(key)!, 'B'));
    } else if (!baseHas && aHas && bHas) {
      const ra = addedA.get(key)!;
      const rb = addedB.get(key)!;
      if (sameCells(ra.cells, rb.cells)) {
        proposals.push(rowAdd(sheet, ra, 'both'));
      } else {
        conflicts.push({
          id: `ADD_ADD:${sheet}:${key}`,
          type: 'ADD_ADD',
          sheet,
          key,
          aCells: ra.cells,
          bCells: rb.cells,
          afterKey: ra.afterKey,
        });
      }
    }
  }

  void labels;
}

function classifyBothPresent(
  sheet: string,
  key: string,
  dA: MergeEdit[],
  dB: MergeEdit[],
  proposals: Proposal[],
  conflicts: Conflict[],
): void {
  if (dA.length === 0 && dB.length === 0) return;
  if (dA.length > 0 && dB.length === 0) {
    for (const e of dA) proposals.push(cellProposal(sheet, key, e, 'A'));
    return;
  }
  if (dB.length > 0 && dA.length === 0) {
    for (const e of dB) proposals.push(cellProposal(sheet, key, e, 'B'));
    return;
  }

  // Both edited this row.
  const colsA = new Map(dA.map((e) => [e.column, e]));
  const colsB = new Map(dB.map((e) => [e.column, e]));
  const common = [...colsA.keys()].filter((c) => colsB.has(c));
  const sameColDiff = common.filter((c) => !scalarEq(colsA.get(c)!.value, colsB.get(c)!.value));

  if (sameColDiff.length > 0) {
    // Same cell, different value → CELL conflict(s). Equal common cols and
    // disjoint edits become proposals.
    for (const col of sameColDiff) {
      conflicts.push({
        id: `CELL:${sheet}:${key}:${col}`,
        type: 'CELL',
        sheet,
        key,
        column: col,
        base: colsA.get(col)!.base,
        aValue: colsA.get(col)!.value,
        bValue: colsB.get(col)!.value,
      });
    }
    for (const col of common) {
      if (sameColDiff.includes(col)) continue;
      proposals.push(cellProposal(sheet, key, colsA.get(col)!, 'both'));
    }
    for (const e of dA) if (!colsB.has(e.column)) proposals.push(cellProposal(sheet, key, e, 'A'));
    for (const e of dB) if (!colsA.has(e.column)) proposals.push(cellProposal(sheet, key, e, 'B'));
    return;
  }

  if (common.length === 0) {
    // Different cells → RELATED_EDITS (row level, all of ΔA and ΔB).
    conflicts.push({
      id: `RELATED_EDITS:${sheet}:${key}`,
      type: 'RELATED_EDITS',
      sheet,
      key,
      aEdits: dA.map(toCellEdit),
      bEdits: dB.map(toCellEdit),
      why: 'Both edited different cells in this row — accepting both could double-correct the same thing.',
    });
    return;
  }

  // All common columns equal → one proposal (both); plus disjoint edits.
  for (const col of common) proposals.push(cellProposal(sheet, key, colsA.get(col)!, 'both'));
  for (const e of dA) if (!colsB.has(e.column)) proposals.push(cellProposal(sheet, key, e, 'A'));
  for (const e of dB) if (!colsA.has(e.column)) proposals.push(cellProposal(sheet, key, e, 'B'));
}

function deleteVsEdit(
  sheet: string,
  key: string,
  deletedBy: 'A' | 'B',
  editedBy: 'A' | 'B',
  edits: MergeEdit[],
  proposals: Proposal[],
  conflicts: Conflict[],
): void {
  if (edits.length === 0) {
    proposals.push(rowDelete(sheet, key, deletedBy));
    return;
  }
  conflicts.push({
    id: `DELETE_EDIT:${sheet}:${key}`,
    type: 'DELETE_EDIT',
    sheet,
    key,
    deletedBy,
    editedBy,
    edits: edits.map(toCellEdit),
  });
}

function toCellEdit(e: MergeEdit): CellEdit {
  const c: CellEdit = { column: e.column, base: e.base, value: e.value };
  if (e.valueFormula !== undefined) c.formula = e.valueFormula;
  return c;
}

function cellProposal(sheet: string, key: string, e: MergeEdit, source: Proposal['source']): Proposal {
  const p: Proposal = {
    id: `cell:${sheet}:${key}:${e.column}`,
    kind: 'cell',
    sheet,
    key,
    source,
    selected: true,
    column: e.column,
    base: e.base,
    value: e.value,
  };
  if (e.valueFormula !== undefined) p.formula = e.valueFormula;
  return p;
}

function rowAdd(sheet: string, added: MergeAdded, source: Proposal['source']): Proposal {
  return {
    id: `row_add:${sheet}:${added.key}`,
    kind: 'row_add',
    sheet,
    key: added.key,
    source,
    selected: true,
    afterKey: added.afterKey,
    cells: added.cells,
    sourceRow: added.sourceRow,
  };
}

function rowDelete(sheet: string, key: string, source: Proposal['source']): Proposal {
  return { id: `row_delete:${sheet}:${key}`, kind: 'row_delete', sheet, key, source, selected: true };
}
