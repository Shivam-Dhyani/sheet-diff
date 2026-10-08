import { CellKind, type SheetIR, type StringPool, type WorkbookIR } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import type { CompareResult, Scalar, Finding, CellChange } from '../types.js';
import { RowState } from '../types.js';
import { resolveCompareOptions, type CompareOptions } from '../options.js';
import { compareCore } from '../compare/index.js';
import type { CheckPair } from '../checks/context.js';
import { rowKey } from '../merge/diff.js';
import type {
  ReportModel,
  ReportChange,
  MarkedSheet,
  MarkedRow,
  MarkedCell,
  RemovedRow,
} from './types.js';

export type { ReportModel } from './types.js';
export { buildCopySummary } from './copy-summary.js';
export type { CopySummaryOptions } from './copy-summary.js';

function scalar(sheet: SheetIR, pool: StringPool, r: number, c: number): Scalar {
  const cell = getCell(sheet, pool, r, c);
  switch (cell.kind) {
    case CellKind.Empty:
      return null;
    case CellKind.Number:
    case CellKind.DateSerial:
      return cell.num;
    case CellKind.Boolean:
      return cell.num !== 0;
    default:
      return cell.text;
  }
}

export interface ReportOptions extends Partial<CompareOptions> {
  now?: Date;
}

/** Build the structured report data model (TDD §6.3 / FR-REP-01). */
export function buildReportModel(
  result: CompareResult,
  oldWb: WorkbookIR,
  newWb: WorkbookIR,
  opts?: ReportOptions,
): ReportModel {
  const options = resolveCompareOptions(opts);
  const { checkContext } = compareCore(oldWb, newWb, options);
  const pairs = checkContext.pairs;

  const pairNewName = new Map(result.pairs.map((p) => [p.id, p.newName ?? p.oldName ?? p.id]));
  const changeIndex = new Map<string, CellChange>();
  for (const p of result.pairs) {
    for (const ch of p.cellChanges) changeIndex.set(`${ch.pairId}|${ch.key}|${ch.column}`, ch);
  }

  const forInformation = result.findings.filter((f) => f.severity === 'info').length;

  const allChanges = buildAllChanges(result.findings, pairNewName, changeIndex);
  const markedSheets = pairs
    .filter((p): p is CheckPair & { newSheet: SheetIR } => (p.status === 'matched' || p.status === 'renamed') && !!p.newSheet)
    .map((p) => buildMarkedSheet(p, result, oldWb, newWb, options));

  const primary = result.pairs.find((p) => p.key.mode !== 'order') ?? result.pairs[0];
  // The contrast line reflects the primary data sheet (a naive same-address
  // compare of it), not the sum across sheets (FR-RES-01).
  const contrastCells = primary
    ? (result.positionalBaseline[primary.id] ??
      Object.values(result.positionalBaseline).reduce((a, b) => a + b, 0))
    : 0;
  const matchedBy = primary
    ? primary.key.mode === 'order'
      ? 'row order (no key column)'
      : `${primary.key.columns.join(', ')} (auto-detected: unique in both files)`
    : '—';

  return {
    meta: {
      oldFile: oldWb.fileName,
      newFile: newWb.fileName,
      matchedBy,
      generated: (opts?.now ?? new Date()).toISOString().slice(0, 10),
    },
    overview: {
      counts: result.counts,
      forInformation,
      contrastCells,
      attention: result.findings.filter((f) => f.severity === 'high'),
    },
    allChanges,
    markedSheets,
  };
}

function buildAllChanges(
  findings: Finding[],
  pairNewName: Map<string, string>,
  changeIndex: Map<string, CellChange>,
): ReportChange[] {
  return findings.map((f, i) => {
    const ch =
      f.pairId && f.key && f.column
        ? changeIndex.get(`${f.pairId}|${f.key}|${f.column}`)
        : undefined;
    let oldV: Scalar = ch ? ch.old : null;
    let newV: Scalar = ch ? ch.new : null;
    if (f.rule === 'ROW_ADDED') {
      oldV = null;
      newV = f.key ?? null;
    } else if (f.rule === 'ROW_REMOVED') {
      oldV = f.key ?? null;
      newV = null;
    }
    // Grouped findings (e.g. CHK-02) carry their keys in `data`, not `key`.
    const excluded = Array.isArray(f.data['excludedKeys']) ? (f.data['excludedKeys'] as string[]) : undefined;
    const key = f.key ?? (excluded && excluded.length > 0 ? excluded.join(', ') : '—');
    return {
      index: i + 1,
      risk: f.severity,
      where: f.pairId ? (pairNewName.get(f.pairId) ?? '—') : '—',
      key,
      column: f.column ?? '—',
      whatChanged: f.title,
      old: oldV,
      new: newV,
      meaning: f.message,
      rule: f.rule,
    };
  });
}

function buildMarkedSheet(
  p: CheckPair,
  result: CompareResult,
  oldWb: WorkbookIR,
  newWb: WorkbookIR,
  options: CompareOptions,
): MarkedSheet {
  const newSheet = p.newSheet!;
  const oldSheet = p.oldSheet!;
  const newTable = p.newTable!;
  const pairResult = result.pairs.find((x) => x.id === p.id)!;

  // columns present on the new side, in column order.
  const columns = pairResult.columns
    .filter((c) => c.newIndex !== undefined && c.newName !== undefined)
    .sort((a, b) => a.newIndex! - b.newIndex!)
    .map((c) => ({ header: c.newName!, col: c.newIndex! }));

  // cell changes indexed by (row, col) on the new side.
  const changeAt = new Map<string, CellChange>();
  for (const ch of pairResult.cellChanges) {
    if (ch.newCell) changeAt.set(`${ch.newCell.r}:${ch.newCell.c}`, ch);
  }
  const highKeyCol = new Set<string>();
  for (const f of result.findings) {
    if (f.severity === 'high' && f.pairId === p.id && f.key && f.column) highKeyCol.add(`${f.key}|${f.column}`);
  }

  const newKeyCols = p.newKeyCols ?? [];
  const rows: MarkedRow[] = [];
  for (let r = newTable.dataStart; r <= newTable.dataEnd; r++) {
    const statusIdx = r - newTable.dataStart;
    const status = (pairResult.rowStatus[statusIdx] ?? RowState.Unchanged) as RowState;
    const key = rowKey(newSheet, newWb.pool, newKeyCols, r);
    const cells: MarkedCell[] = columns.map(({ col, header }) => {
      const ch = changeAt.get(`${r}:${col}`);
      const recalculated = ch?.kind === 'recalculated';
      const changed = !!ch && ch.kind !== 'recalculated' && ch.kind !== 'format_changed';
      const cell: MarkedCell = {
        value: scalar(newSheet, newWb.pool, r, col),
        changed,
        recalculated,
        high: highKeyCol.has(`${key}|${header}`),
      };
      if (ch) cell.oldValue = ch.old;
      return cell;
    });
    rows.push({ status, key, cells });
  }

  // removed rows, with the surviving-predecessor key for placement.
  const removedSet = new Set(p.removed ?? []);
  const oldKeyCols = p.oldKeyCols ?? [];
  const oldTable = p.oldTable!;
  // old column → new column order mapping for removed-row cells.
  const oldColFor = new Map<number, number>(); // newIndex → oldIndex
  for (const c of pairResult.columns) {
    if (c.newIndex !== undefined && c.oldIndex !== undefined) oldColFor.set(c.newIndex, c.oldIndex);
  }
  const removed: RemovedRow[] = [];
  let lastSurviving: string | null = null;
  for (let r = oldTable.dataStart; r <= oldTable.dataEnd; r++) {
    const key = rowKey(oldSheet, oldWb.pool, oldKeyCols, r);
    if (removedSet.has(r)) {
      removed.push({
        key,
        afterKey: lastSurviving,
        cells: columns.map(({ col }) => {
          const oc = oldColFor.get(col);
          return oc !== undefined ? scalar(oldSheet, oldWb.pool, r, oc) : null;
        }),
      });
    } else if (key !== '') {
      lastSurviving = key;
    }
  }

  void options;
  return { name: newSheet.name, columns: columns.map((c) => c.header), rows, removed };
}
