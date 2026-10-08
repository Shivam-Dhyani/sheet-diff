import { CellKind, type SheetIR, type StringPool, type WorkbookIR } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import type { Scalar, ChangeKind, KeyMode, PairStatus } from '../types.js';
import { resolveCompareOptions, type CompareOptions } from '../options.js';
import { compareCore } from '../compare/index.js';
import type { TableModel } from '../table/index.js';
import type { RowCell } from './types.js';

const INPUT_KINDS = new Set<ChangeKind>([
  'value_changed',
  'type_changed',
  'formula_changed',
  'formula_overwritten',
  'formula_added',
]);

export interface MergeEdit {
  key: string;
  column: string;
  kind: ChangeKind;
  base: Scalar;
  value: Scalar;
  baseFormula?: string;
  valueFormula?: string;
}

export interface MergeAdded {
  key: string;
  afterKey: string | null;
  /** 0-based absolute row in the copy (for re-anchoring the row's formulas). */
  sourceRow: number;
  cells: RowCell[];
}

export interface MergePairDiff {
  sheetName: string;
  status: PairStatus;
  mode: KeyMode;
  keyColumns: string[];
  baseKeys: string[];
  edits: MergeEdit[];
  added: MergeAdded[];
  removed: string[];
}

/** Display key matching the compare pipeline's `keyOf` (join raw values with " / "). */
export function rowKey(sheet: SheetIR, pool: StringPool, cols: number[], row: number): string {
  if (cols.length === 0) return '';
  return cols
    .map((c) => {
      const cell = getCell(sheet, pool, row, c);
      return cell.kind === CellKind.String || cell.kind === CellKind.Error
        ? cell.text
        : String(cell.num);
    })
    .join(' / ');
}

function enumerateKeys(sheet: SheetIR, pool: StringPool, table: TableModel, cols: number[]): string[] {
  const keys: string[] = [];
  for (let r = table.dataStart; r <= table.dataEnd; r++) {
    const k = rowKey(sheet, pool, cols, r);
    if (k !== '') keys.push(k);
  }
  return keys;
}

function cellSpec(sheet: SheetIR, pool: StringPool, row: number, col: number, header: string): RowCell | null {
  const cell = getCell(sheet, pool, row, col);
  if (cell.kind === CellKind.Empty && cell.formula === undefined) return null;
  const spec: RowCell = { column: header };
  if (cell.formula !== undefined) spec.formula = cell.formula;
  switch (cell.kind) {
    case CellKind.Number:
    case CellKind.DateSerial:
      spec.value = cell.num;
      break;
    case CellKind.Boolean:
      spec.value = cell.num !== 0;
      break;
    case CellKind.Empty:
      break;
    default:
      spec.value = cell.text;
  }
  return spec;
}

/** Nearest preceding row (in the copy's order) whose key exists in base. */
function anchorFor(
  sheet: SheetIR,
  pool: StringPool,
  keyCols: number[],
  table: TableModel,
  row: number,
  baseKeys: Set<string>,
): string | null {
  for (let r = row - 1; r >= table.dataStart; r--) {
    const k = rowKey(sheet, pool, keyCols, r);
    if (k !== '' && baseKeys.has(k)) return k;
  }
  return null;
}

/**
 * Structured per-sheet diff between a base workbook and one edited copy,
 * reusing the compare core so classification (recalculated vs real change,
 * formula translation / BR-C3) is identical to `compareWorkbooks`.
 */
export function mergeDiff(
  base: WorkbookIR,
  copy: WorkbookIR,
  opts?: Partial<CompareOptions>,
): MergePairDiff[] {
  const options = resolveCompareOptions(opts);
  const { checkContext } = compareCore(base, copy, options);
  const out: MergePairDiff[] = [];

  for (const p of checkContext.pairs) {
    if (p.status === 'added' || p.status === 'removed' || !p.oldSheet || !p.newSheet) {
      out.push({
        sheetName: p.result.newName ?? p.result.oldName ?? p.id,
        status: p.status,
        mode: 'order',
        keyColumns: [],
        baseKeys: [],
        edits: [],
        added: [],
        removed: [],
      });
      continue;
    }

    const baseSheet = p.oldSheet;
    const copySheet = p.newSheet;
    const baseKeyCols = p.oldKeyCols ?? [];
    const copyKeyCols = p.newKeyCols ?? [];
    const baseKeys = enumerateKeys(baseSheet, base.pool, p.oldTable!, baseKeyCols);
    const baseKeySet = new Set(baseKeys);

    const edits: MergeEdit[] = [];
    for (const c of p.result.cellChanges) {
      if (!INPUT_KINDS.has(c.kind)) continue;
      const e: MergeEdit = { key: c.key, column: c.column, kind: c.kind, base: c.old, value: c.new };
      if (c.oldFormula !== undefined) e.baseFormula = c.oldFormula;
      if (c.newFormula !== undefined) e.valueFormula = c.newFormula;
      edits.push(e);
    }

    const added: MergeAdded[] = [];
    for (const row of p.added ?? []) {
      const key = rowKey(copySheet, copy.pool, copyKeyCols, row);
      const afterKey = anchorFor(copySheet, copy.pool, copyKeyCols, p.newTable!, row, baseKeySet);
      const cells: RowCell[] = [];
      for (const col of p.columns ?? []) {
        const spec = cellSpec(copySheet, copy.pool, row, col.newCol, col.header);
        if (spec) cells.push(spec);
      }
      added.push({ key, afterKey, sourceRow: row, cells });
    }

    const removed = (p.removed ?? []).map((r) => rowKey(baseSheet, base.pool, baseKeyCols, r));

    out.push({
      sheetName: copySheet.name,
      status: p.status,
      mode: p.result.key.mode,
      keyColumns: p.result.key.columns,
      baseKeys,
      edits,
      added,
      removed,
    });
  }

  return out;
}
