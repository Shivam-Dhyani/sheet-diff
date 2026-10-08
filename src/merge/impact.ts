import { CellKind, type SheetIR, type WorkbookIR } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import { rcToA1, colToLetter } from '../ir/coords.js';
import { resolveCompareOptions, type CompareOptions } from '../options.js';
import { detectTable, type TableModel } from '../table/index.js';
import { matchColumns } from '../match/columns.js';
import { detectKey } from '../match/keys.js';
import { translateFormula, type TranslateContext } from '../formula/translate.js';
import { evaluateFormula, isUnknown, type EvalContext } from '../formula/evaluator.js';
import type { CellScalar } from '../formula/functions.js';
import { tokenize } from '../formula/tokenizer.js';
import { parseRef } from '../formula/refs.js';
import { rowKey } from './diff.js';
import type { MergeChangeSet, ImpactRow, ChangeSetExtendRange } from './types.js';

interface MergedCell {
  value?: CellScalar;
  formula?: string;
}

interface MergedSheet {
  name: string;
  table: TableModel;
  keyCols: number[];
  cols: number;
  /** merged absolute row → (col → cell). */
  grid: Map<number, Map<number, MergedCell>>;
  /** base absolute row → merged absolute row (−1 deleted). */
  baseToMerged: Map<number, number>;
  mergedDataEnd: number;
}

/** Build the virtual merged model of the base workbook under a change set (TDD §9.3). */
export function buildMergedModel(
  base: WorkbookIR,
  changeSet: MergeChangeSet,
  opts?: Partial<CompareOptions>,
): { context: EvalContext; sheets: Map<string, MergedSheet> } {
  const options = resolveCompareOptions(opts);
  const sheets = new Map<string, MergedSheet>();

  // Group change-set entries by sheet.
  const editsBySheet = groupBy(changeSet.cellEdits, (e) => e.sheet);
  const insertsBySheet = groupBy(changeSet.rowInserts, (e) => e.sheet);
  const deletesBySheet = groupBy(changeSet.rowDeletes, (e) => e.sheet);

  for (const baseSheet of base.sheets) {
    const table = detectTable(baseSheet, base.pool);
    // Only sheets with a resolved key participate in row insert/delete merging.
    const self = compareSelf(baseSheet, base, table, options);
    const keyCols = self.keyCols;

    const edits = editsBySheet.get(baseSheet.name) ?? [];
    const inserts = insertsBySheet.get(baseSheet.name) ?? [];
    const deletes = new Set((deletesBySheet.get(baseSheet.name) ?? []).map((d) => d.key));
    const headerToCol = new Map(self.columns.map((c) => [c.header, c.index]));
    const editByKeyCol = new Map<string, Map<string, (typeof edits)[number]>>();
    for (const e of edits) {
      (editByKeyCol.get(e.key) ?? editByKeyCol.set(e.key, new Map()).get(e.key)!).set(e.column, e);
    }
    const insertsAfter = groupBy(inserts, (i) => i.afterKey ?? '\u0000TOP');

    // Build the merged row order (base rows minus deletes, with inserts after anchors).
    interface Row {
      kind: 'base' | 'insert';
      baseRow?: number;
      key: string;
      insert?: (typeof inserts)[number];
    }
    const order: Row[] = [];
    const emitInsertsAfter = (anchorKey: string): void => {
      for (const ins of insertsAfter.get(anchorKey) ?? []) order.push({ kind: 'insert', key: ins.key, insert: ins });
    };
    emitInsertsAfter('\u0000TOP');
    for (let r = table.dataStart; r <= table.dataEnd; r++) {
      const key = rowKey(baseSheet, base.pool, keyCols, r);
      if (key !== '' && deletes.has(key)) continue;
      order.push({ kind: 'base', baseRow: r, key });
      if (key !== '') emitInsertsAfter(key);
    }

    // Assign merged absolute rows and build the grid.
    const grid = new Map<number, Map<number, MergedCell>>();
    const baseToMerged = new Map<number, number>();
    for (let r = table.dataStart; r <= table.dataEnd; r++) baseToMerged.set(r, -1);

    let mergedRow = table.dataStart;
    for (const row of order) {
      const cells = new Map<number, MergedCell>();
      if (row.kind === 'base' && row.baseRow !== undefined) {
        baseToMerged.set(row.baseRow, mergedRow);
        const delta = mergedRow - row.baseRow;
        for (let c = 0; c < baseSheet.cols; c++) {
          const cell = getCell(baseSheet, base.pool, row.baseRow, c);
          const mc: MergedCell = {};
          if (cell.formula !== undefined) mc.formula = reanchor(cell.formula, baseSheet.name, delta);
          else mc.value = scalar(cell);
          cells.set(c, mc);
        }
        // apply edits
        const colEdits = editByKeyCol.get(row.key);
        if (colEdits) {
          for (const [col, e] of colEdits) {
            const ci = headerToCol.get(col);
            if (ci === undefined) continue;
            cells.set(ci, e.formula !== undefined ? { formula: e.formula } : { value: toCellScalar(e.value) });
          }
        }
      } else if (row.insert) {
        const delta = row.insert.sourceRow !== undefined ? mergedRow - row.insert.sourceRow : 0;
        for (const rc of row.insert.cells) {
          const ci = headerToCol.get(rc.column);
          if (ci === undefined) continue;
          cells.set(
            ci,
            rc.formula !== undefined
              ? { formula: reanchor(rc.formula, baseSheet.name, delta) }
              : { value: toCellScalar(rc.value ?? null) },
          );
        }
      }
      grid.set(mergedRow, cells);
      mergedRow++;
    }

    sheets.set(baseSheet.name, {
      name: baseSheet.name,
      table,
      keyCols,
      cols: baseSheet.cols,
      grid,
      baseToMerged,
      mergedDataEnd: mergedRow - 1,
    });
  }

  const context = makeMergedContext(base, sheets);
  return { context, sheets };
}

/** Re-anchor a strictly same-row-relative formula by a row delta on its own sheet. */
function reanchor(formula: string, sheetName: string, delta: number): string {
  if (delta === 0) return formula;
  const ctx: TranslateContext = {
    defaultSheet: sheetName,
    rowMap: (sheet, r) => (sheet === sheetName ? r + delta : r),
    colMap: (_s, c) => c,
    rowCount: () => 1_000_000,
    colCount: () => 1_000_000,
  };
  return translateFormula(formula, ctx);
}

function makeMergedContext(base: WorkbookIR, sheets: Map<string, MergedSheet>): EvalContext {
  const byName = new Map(base.sheets.map((s) => [s.name, s]));
  const ctx: EvalContext = {
    defaultSheet: '',
    sheetExists: (s) => byName.has(s),
    rowCount: (s) => {
      const merged = sheets.get(s);
      return merged ? Math.max(byName.get(s)?.rows ?? 0, merged.mergedDataEnd + 1) : (byName.get(s)?.rows ?? 0);
    },
    colCount: (s) => byName.get(s)?.cols ?? 0,
    getCell: (s, r, c): CellScalar => {
      const merged = sheets.get(s);
      if (merged) {
        const cell = merged.grid.get(r)?.get(c);
        if (cell) {
          if (cell.formula !== undefined) {
            const v = evaluateFormula(cell.formula, { ...ctx, defaultSheet: s });
            return isUnknown(v) || typeof v === 'object' ? null : (v as CellScalar);
          }
          return cell.value ?? null;
        }
        // outside the merged data region → fall back to base cell (header/title rows)
      }
      const sheet = byName.get(s);
      if (!sheet) return null;
      return scalar(getCell(sheet, base.pool, r, c));
    },
  };
  return ctx;
}

function scalar(cell: ReturnType<typeof getCell>): CellScalar {
  switch (cell.kind) {
    case CellKind.Empty:
      return null;
    case CellKind.Number:
    case CellKind.DateSerial:
      return cell.num;
    case CellKind.Boolean:
      return cell.num !== 0;
    case CellKind.Error:
      return { err: cell.text };
    default:
      return cell.text;
  }
}

function toCellScalar(v: unknown): CellScalar {
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v as CellScalar;
  return String(v);
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) (m.get(key(it)) ?? m.set(key(it), []).get(key(it))!).push(it);
  return m;
}

/** Minimal self-compare to resolve a sheet's key columns against itself. */
function compareSelf(
  sheet: SheetIR,
  base: WorkbookIR,
  table: TableModel,
  options: CompareOptions,
): { keyCols: number[]; columns: { header: string; index: number }[] } {
  const cm = matchColumns(sheet, sheet, table, table, base.pool, base.pool);
  const key = detectKey(sheet, sheet, table, table, cm.common, base.pool, base.pool, options);
  return {
    keyCols: key.newCols,
    columns: cm.common.map((c) => ({ header: c.header, index: c.newIndex })),
  };
}

/** A Summary/total formula: outside a table, referencing a table range. */
function isTotalFormula(formula: string, tableSheets: Set<string>, hostSheet: string): boolean {
  for (const t of tokenize(formula)) {
    if (t.type !== 'ref') continue;
    const ref = parseRef(t.value);
    if (!ref) continue;
    const target = ref.sheet ?? hostSheet;
    if (tableSheets.has(target) && (ref.kind === 'range' || ref.kind === 'cols')) return true;
  }
  return false;
}

/**
 * Preview the effect on known totals (TDD §9.3 / FR-MRG-04). Evaluates every
 * total formula (outside a table, referencing a table range) on the virtual
 * merged model, with the change set's extend-ranges applied.
 */
export function previewImpact(
  base: WorkbookIR,
  changeSet: MergeChangeSet,
  opts?: Partial<CompareOptions>,
): ImpactRow[] {
  const { context, sheets } = buildMergedModel(base, changeSet, opts);
  const tableSheets = new Set(sheets.keys());
  const extendByCell = new Map<string, ChangeSetExtendRange[]>();
  for (const er of changeSet.extendRanges) {
    const k = `${er.sheet}!${er.cell}`;
    (extendByCell.get(k) ?? extendByCell.set(k, []).get(k)!).push(er);
  }

  const rows: ImpactRow[] = [];
  for (const sheet of base.sheets) {
    if (sheets.has(sheet.name) && detectTable(sheet, base.pool).columns.length > 0) {
      // sheets that are themselves tables still may hold out-of-table totals; we
      // only treat *formula* cells referencing a table range as totals.
    }
    for (const [idx, fId] of sheet.formula) {
      const r = Math.floor(idx / sheet.cols);
      const c = idx % sheet.cols;
      const formula = base.pool.get(fId);
      if (!formula || !isTotalFormula(formula, tableSheets, sheet.name)) continue;

      const before = scalarNumber(scalar(getCell(sheet, base.pool, r, c)));
      const translated = translateMergedFormula(formula, sheet.name, sheets);
      const extended = applyExtend(translated, extendByCell.get(`${sheet.name}!${rcToA1(r, c)}`) ?? []);
      const v = evaluateFormula(extended, { ...context, defaultSheet: sheet.name });
      const after: number | 'excel' = isUnknown(v) || typeof v !== 'number' ? 'excel' : v;
      rows.push({
        sheet: sheet.name,
        label: labelFor(sheet, base, r, c),
        cell: rcToA1(r, c),
        before,
        after,
      });
    }
  }
  return rows;
}

function translateMergedFormula(formula: string, hostSheet: string, sheets: Map<string, MergedSheet>): string {
  const ctx: TranslateContext = {
    defaultSheet: hostSheet,
    rowMap: (sheet, rr) => {
      const merged = sheets.get(sheet);
      if (!merged) return rr;
      const m = merged.baseToMerged.get(rr);
      return m === undefined ? rr : m;
    },
    colMap: (_s, c) => c,
    rowCount: (sheet) => sheets.get(sheet)?.table.dataEnd ?? 1_000_000,
    colCount: () => 1_000_000,
  };
  return translateFormula(formula, ctx);
}

/** Rewrite a formula's range ends to the extend targets (each from→to). */
function applyExtend(formula: string, extends_: ChangeSetExtendRange[]): string {
  let out = formula;
  for (const e of extends_) {
    out = out.replace(new RegExp(`:(\\$?)${escapeRe(e.from)}(?![0-9A-Za-z])`, 'g'), `:$1${e.to}`);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelFor(sheet: SheetIR, base: WorkbookIR, r: number, c: number): string {
  // The cell to the left (e.g. the Particulars column).
  for (let cc = c - 1; cc >= 0; cc--) {
    const cell = getCell(sheet, base.pool, r, cc);
    if (cell.kind === CellKind.String && cell.text.trim() !== '') return cell.text.trim();
    if (cell.kind !== CellKind.Empty) break;
  }
  return rcToA1(r, c);
}

function scalarNumber(v: CellScalar): number | null {
  return typeof v === 'number' ? v : null;
}

/**
 * Compute the extend-ranges (TDD §9.2): for each total formula that, after
 * translation, still ends before the merged data end (new rows appended below
 * the range), extend its Sales-Register range end to the merged data end.
 */
export function computeExtendRanges(
  base: WorkbookIR,
  changeSet: MergeChangeSet,
  opts?: Partial<CompareOptions>,
): ChangeSetExtendRange[] {
  const { sheets } = buildMergedModel(base, changeSet, opts);
  const tableSheets = new Set(sheets.keys());
  const out: ChangeSetExtendRange[] = [];
  const seen = new Set<string>();

  for (const sheet of base.sheets) {
    for (const [idx, fId] of sheet.formula) {
      const r = Math.floor(idx / sheet.cols);
      const c = idx % sheet.cols;
      const formula = base.pool.get(fId);
      if (!formula || !isTotalFormula(formula, tableSheets, sheet.name)) continue;
      const translated = translateMergedFormula(formula, sheet.name, sheets);
      for (const t of tokenize(translated)) {
        if (t.type !== 'ref') continue;
        const ref = parseRef(t.value);
        if (!ref || ref.kind !== 'range') continue;
        const target = ref.sheet ?? sheet.name;
        const merged = sheets.get(target);
        if (!merged) continue;
        if (ref.r2 < merged.mergedDataEnd) {
          const fromA1 = `${colToLetter(ref.c2)}${ref.r2 + 1}`;
          const toA1 = `${colToLetter(ref.c2)}${merged.mergedDataEnd + 1}`;
          const cellRef = rcToA1(r, c);
          const dedupe = `${sheet.name}!${cellRef}!${fromA1}`;
          if (!seen.has(dedupe)) {
            seen.add(dedupe);
            out.push({ sheet: sheet.name, cell: cellRef, from: fromA1, to: toA1 });
          }
        }
      }
    }
  }
  return out;
}
