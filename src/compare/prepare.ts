import { CellKind, type SheetIR, type StringPool, type WorkbookIR } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import { normalizeHeader } from '../match/columns.js';
import type { CompareOptions } from '../options.js';
import { detectTable, type TableModel } from '../table/index.js';
import { matchColumns, type ColumnMatchResult } from '../match/columns.js';
import { detectKey, type KeyResult } from '../match/keys.js';
import { pairSheets, type SheetSignature } from '../match/sheets.js';
import { hashRow } from '../match/hash.js';

export interface PreparedPair {
  id: string;
  status: 'matched' | 'renamed' | 'added' | 'removed';
  oldName?: string;
  newName?: string;
  oldIndex?: number;
  newIndex?: number;
  oldTable?: TableModel;
  newTable?: TableModel;
  columnMatch?: ColumnMatchResult;
  key?: KeyResult;
}

function signature(sheet: SheetIR, pool: StringPool, table: TableModel, opts: CompareOptions): SheetSignature {
  const headers = new Set<string>();
  for (const col of table.columns) headers.add(normalizeHeader(col.header));
  const rowHashes = new Set<bigint>();
  const allCols = table.columns.map((c) => c.index);
  const limit = Math.min(table.dataEnd, table.dataStart + 199);
  for (let r = table.dataStart; r <= limit; r++) {
    rowHashes.add(hashRow(sheet, pool, r, allCols, opts));
  }
  return { name: sheet.name, headers, rowHashes };
}

/** new-side numeric-dominant column indices (for the CHK-06 flag). */
export function numericColumns(sheet: SheetIR, pool: StringPool, table: TableModel): Set<number> {
  const out = new Set<number>();
  for (const col of table.columns) {
    let num = 0;
    let nonEmpty = 0;
    for (let r = table.dataStart; r <= table.dataEnd; r++) {
      const cell = getCell(sheet, pool, r, col.index);
      if (cell.kind === CellKind.Empty && cell.formula === undefined) continue;
      nonEmpty++;
      if (cell.kind === CellKind.Number) num++;
    }
    if (nonEmpty > 0 && num / nonEmpty >= 0.9) out.add(col.index);
  }
  return out;
}

/**
 * Detect tables, pair sheets, and (for matched pairs) match columns and detect
 * keys. Shared by {@link analyzePair} and {@link compareWorkbooks}.
 */
export function preparePairs(
  oldWb: WorkbookIR,
  newWb: WorkbookIR,
  opts: CompareOptions,
): PreparedPair[] {
  const oldTables = oldWb.sheets.map((s) => detectTable(s, oldWb.pool, headerOverride(opts, s.name)));
  const newTables = newWb.sheets.map((s) => detectTable(s, newWb.pool, headerOverride(opts, s.name)));

  const oldSigs = oldWb.sheets.map((s, i) => signature(s, oldWb.pool, oldTables[i]!, opts));
  const newSigs = newWb.sheets.map((s, i) => signature(s, newWb.pool, newTables[i]!, opts));

  const pairings = pairSheets(oldSigs, newSigs);
  const prepared: PreparedPair[] = [];

  for (const p of pairings) {
    const oldIndex = p.oldName !== undefined ? oldWb.sheets.findIndex((s) => s.name === p.oldName) : -1;
    const newIndex = p.newName !== undefined ? newWb.sheets.findIndex((s) => s.name === p.newName) : -1;
    const id = pairId(p.oldName, p.newName);

    if (p.status === 'added' || p.status === 'removed') {
      prepared.push({
        id,
        status: p.status,
        ...(p.oldName !== undefined ? { oldName: p.oldName } : {}),
        ...(p.newName !== undefined ? { newName: p.newName } : {}),
      });
      continue;
    }

    const oldSheet = oldWb.sheets[oldIndex]!;
    const newSheet = newWb.sheets[newIndex]!;
    const oldTable = oldTables[oldIndex]!;
    const newTable = newTables[newIndex]!;
    const columnMatch = matchColumns(oldSheet, newSheet, oldTable, newTable, oldWb.pool, newWb.pool);
    const key = detectKey(
      oldSheet,
      newSheet,
      oldTable,
      newTable,
      columnMatch.common,
      oldWb.pool,
      newWb.pool,
      opts,
      opts.keys?.[id],
    );

    prepared.push({
      id,
      status: p.status,
      oldName: p.oldName!,
      newName: p.newName!,
      oldIndex,
      newIndex,
      oldTable,
      newTable,
      columnMatch,
      key,
    });
  }

  return prepared;
}

function headerOverride(opts: CompareOptions, sheetName: string): { headerRow?: number } | undefined {
  // Header overrides are keyed by pairId in CompareOptions; a per-sheet lookup
  // is not available before pairing, so overrides apply in compareWorkbooks.
  void opts;
  void sheetName;
  return undefined;
}

export function pairId(oldName?: string, newName?: string): string {
  return `${oldName ?? '∅'}→${newName ?? '∅'}`;
}
