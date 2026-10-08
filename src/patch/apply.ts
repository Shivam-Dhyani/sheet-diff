import { type SheetIR, type WorkbookIR } from '../ir/types.js';
import { colToLetter } from '../ir/coords.js';
import type { CompareOptions } from '../options.js';
import { resolveCompareOptions } from '../options.js';
import { detectTable, type TableModel } from '../table/index.js';
import { matchColumns } from '../match/columns.js';
import { detectKey } from '../match/keys.js';
import { rowKey } from '../merge/diff.js';
import type { MergeChangeSet, ChangeSetExtendRange } from '../merge/types.js';
import type { TranslateContext } from '../formula/translate.js';
import {
  parseWorksheet,
  emitWorksheet,
  renumberRow,
  type Worksheet,
  type WsRow,
} from './worksheet.js';
import { setCell, buildCell, columnStyle, type CellWrite } from './cells.js';
import { rewriteCellFormula, makeTranslate, applyExtendToFormula } from './formulas.js';

export interface SheetMeta {
  table: TableModel;
  keyCols: number[];
  headerToCol: Map<string, number>;
  rowKeyMap: Map<number, string>; // 0-based data row → key
  keyRow: Map<string, number>; // key → 0-based data row
}

export interface SheetChange {
  edits: Map<string, Map<number, CellWrite>>; // key → col → write
  inserts: {
    key: string;
    afterKey: string | null;
    sourceRow?: number;
    cells: { col: number; write: CellWrite; sourceRow?: number }[];
  }[];
  deletes: Set<string>;
}

/** Resolve a base sheet's table, key columns and key↔row maps. */
export function sheetMeta(baseSheet: SheetIR, base: WorkbookIR, options: CompareOptions): SheetMeta {
  const table = detectTable(baseSheet, base.pool);
  const cm = matchColumns(baseSheet, baseSheet, table, table, base.pool, base.pool);
  const key = detectKey(baseSheet, baseSheet, table, table, cm.common, base.pool, base.pool, options);
  const headerToCol = new Map(cm.common.map((c) => [c.header, c.newIndex]));
  const rowKeyMap = new Map<number, string>();
  const keyRow = new Map<string, number>();
  for (let r = table.dataStart; r <= table.dataEnd; r++) {
    const k = rowKey(baseSheet, base.pool, key.newCols, r);
    if (k !== '') {
      rowKeyMap.set(r, k);
      keyRow.set(k, r);
    }
  }
  return { table, keyCols: key.newCols, headerToCol, rowKeyMap, keyRow };
}

/** Build a SheetChange from a change set for one sheet. */
export function sheetChangeFor(
  changeSet: MergeChangeSet,
  sheet: string,
  headerToCol: Map<string, number>,
): SheetChange {
  const edits = new Map<string, Map<number, CellWrite>>();
  for (const e of changeSet.cellEdits) {
    if (e.sheet !== sheet) continue;
    const col = headerToCol.get(e.column);
    if (col === undefined) continue;
    const m = edits.get(e.key) ?? edits.set(e.key, new Map()).get(e.key)!;
    const w: CellWrite = {};
    if (e.formula !== undefined) w.formula = e.formula;
    else w.value = e.value ?? null;
    m.set(col, w);
  }
  const inserts = changeSet.rowInserts
    .filter((i) => i.sheet === sheet)
    .map((i) => ({
      key: i.key,
      afterKey: i.afterKey,
      ...(i.sourceRow !== undefined ? { sourceRow: i.sourceRow } : {}),
      cells: i.cells
        .map((rc) => {
          const col = headerToCol.get(rc.column);
          if (col === undefined) return null;
          const write: CellWrite = {};
          if (rc.formula !== undefined) write.formula = rc.formula;
          else write.value = rc.value ?? null;
          return { col, write, ...(i.sourceRow !== undefined ? { sourceRow: i.sourceRow } : {}) };
        })
        .filter((x): x is { col: number; write: CellWrite; sourceRow?: number } => x !== null),
    }));
  const deletes = new Set(changeSet.rowDeletes.filter((d) => d.sheet === sheet).map((d) => d.key));
  return { edits, inserts, deletes };
}

/**
 * The 0-based old→new row map for a sheet, from its table geometry and the
 * structural changes. Pure (depends only on the base IR + change set), so it
 * can be computed for every sheet before any XML is rewritten — which keeps
 * cross-sheet formula translation correct.
 */
export function computeRowMap(meta: SheetMeta, change: SheetChange): Map<number, number> {
  const map = new Map<number, number>();
  const { table } = meta;
  const insertsAfter = new Map<string, number>();
  for (const ins of change.inserts) insertsAfter.set(ins.afterKey ?? '\u0000TOP', (insertsAfter.get(ins.afterKey ?? '\u0000TOP') ?? 0) + 1);

  let pointer = table.dataStart;
  pointer += insertsAfter.get('\u0000TOP') ?? 0;
  for (let r0 = table.dataStart; r0 <= table.dataEnd; r0++) {
    const key = meta.rowKeyMap.get(r0);
    if (key && change.deletes.has(key)) {
      map.set(r0, -1);
      continue;
    }
    map.set(r0, pointer++);
    if (key) pointer += insertsAfter.get(key) ?? 0;
  }
  const finalDataEnd = pointer - 1;
  const belowShift = finalDataEnd - table.dataEnd;
  // rows above the data range: identity; rows below: shifted.
  for (let r0 = 0; r0 < table.dataStart; r0++) map.set(r0, r0);
  // below rows are mapped lazily by the resolver (r0 + belowShift); record the shift.
  map.set(-1, belowShift); // sentinel: key -1 holds the below-shift
  return map;
}

function resolveRow(map: Map<number, number>, dataEnd: number, r0: number): number {
  if (map.has(r0)) return map.get(r0)!;
  const belowShift = map.get(-1) ?? 0;
  if (r0 > dataEnd) return r0 + belowShift;
  return r0; // above / unknown → identity
}

export interface GlobalMaps {
  /** sheet name → row map. */
  maps: Map<string, Map<number, number>>;
  dataEnd: Map<string, number>;
  rows: Map<string, number>;
  cols: Map<string, number>;
}

function translateCtxFor(hostSheet: string, g: GlobalMaps): TranslateContext {
  return {
    defaultSheet: hostSheet,
    rowMap: (sheet, r) => {
      const m = g.maps.get(sheet);
      return m ? resolveRow(m, g.dataEnd.get(sheet) ?? Infinity, r) : r;
    },
    colMap: (_s, c) => c,
    rowCount: (sheet) => g.rows.get(sheet) ?? 1_000_000,
    colCount: (sheet) => g.cols.get(sheet) ?? 1_000_000,
  };
}

/** Apply a sheet's structural + cell changes to its parsed worksheet. */
export function applyToWorksheet(
  ws: Worksheet,
  baseSheet: SheetIR,
  meta: SheetMeta,
  change: SheetChange,
  g: GlobalMaps,
  extendByCell: Map<string, ChangeSetExtendRange[]>,
): void {
  const sheetName = baseSheet.name;
  const dataEnd = meta.table.dataEnd;
  const translate = makeTranslate(translateCtxFor(sheetName, g));

  const byIndex = new Map<number, WsRow>();
  for (const r of ws.rows) byIndex.set(r.index, r);
  const templateRow = byIndex.get(meta.table.dataStart + 1);
  const insertsAfter = new Map<string, SheetChange['inserts']>();
  for (const ins of change.inserts) {
    const k = ins.afterKey ?? '\u0000TOP';
    (insertsAfter.get(k) ?? insertsAfter.set(k, []).get(k)!).push(ins);
  }

  const above: WsRow[] = [];
  const below: WsRow[] = [];
  for (const r of ws.rows) {
    if (r.index - 1 < meta.table.dataStart) above.push(r);
    else if (r.index - 1 > dataEnd) below.push(r);
  }

  const out: WsRow[] = [];
  const emitExisting = (r0: number, newRow0: number): void => {
    const wsRow = byIndex.get(r0 + 1);
    if (!wsRow) return;
    const renum = renumberRow(wsRow, newRow0 + 1);
    const key = meta.rowKeyMap.get(r0);
    const edits = key ? change.edits.get(key) : undefined;
    for (const c of renum.cells) c.raw = rewriteCellFormula(c.raw, translate);
    if (edits) for (const [col, write] of edits) setCell(renum, col, write, columnStyle(templateRow, col));
    out.push(renum);
  };
  const emitInsert = (ins: SheetChange['inserts'][number], newRow0: number): void => {
    out.push(buildInsertRow(ins, newRow0, meta, templateRow, g, sheetName));
  };

  let pointer = meta.table.dataStart;
  for (const ins of insertsAfter.get('\u0000TOP') ?? []) emitInsert(ins, pointer++);
  for (let r0 = meta.table.dataStart; r0 <= dataEnd; r0++) {
    const key = meta.rowKeyMap.get(r0);
    if (key && change.deletes.has(key)) continue;
    emitExisting(r0, pointer++);
    if (key) for (const ins of insertsAfter.get(key) ?? []) emitInsert(ins, pointer++);
  }
  const belowShift = pointer - 1 - dataEnd;
  const belowOut = below.map((r) => {
    const renum = renumberRow(r, r.index + belowShift);
    for (const c of renum.cells) c.raw = rewriteCellFormula(c.raw, translate);
    return renum;
  });

  // Re-anchor formulas on untouched "above" rows too (harmless if none).
  for (const r of above) for (const c of r.cells) c.raw = rewriteCellFormula(c.raw, translate);

  ws.rows = [...above, ...out, ...belowOut];
  updateDimension(ws, baseSheet.cols);
  void extendByCell;
}

function buildInsertRow(
  ins: SheetChange['inserts'][number],
  newRow0: number,
  meta: SheetMeta,
  templateRow: WsRow | undefined,
  g: GlobalMaps,
  sheetName: string,
): WsRow {
  const index = newRow0 + 1;
  const openTag = templateRow
    ? templateRow.openTag.replace(/(\br=")\d+(")/, `$1${index}$2`)
    : `<row r="${index}">`;
  const delta = ins.sourceRow !== undefined ? newRow0 - ins.sourceRow : 0;
  const reanchor = makeTranslate({
    defaultSheet: sheetName,
    rowMap: (s, r) => (s === sheetName ? r + delta : r),
    colMap: (_s, c) => c,
    rowCount: (s) => g.rows.get(s) ?? 1_000_000,
    colCount: (s) => g.cols.get(s) ?? 1_000_000,
  });
  const cells = [...ins.cells]
    .sort((a, b) => a.col - b.col)
    .map((c) => {
      const ref = `${colToLetter(c.col)}${index}`;
      const write: CellWrite =
        c.write.formula !== undefined ? { formula: reanchor(c.write.formula) } : { value: c.write.value ?? null };
      return { ref, col: c.col, raw: buildCell(ref, write, columnStyle(templateRow, c.col)) };
    });
  return { index, openTag, selfClosing: false, cells };
}

function updateDimension(ws: Worksheet, cols: number): void {
  let maxRow = 0;
  for (const r of ws.rows) maxRow = Math.max(maxRow, r.index);
  const ref = `A1:${colToLetter(Math.max(0, cols - 1))}${Math.max(1, maxRow)}`;
  ws.head = ws.head.replace(/<dimension\b[^>]*\/>/, `<dimension ref="${ref}"/>`);
}

/** Rewrite formulas on an untouched sheet that reference patched sheets. */
export function rewriteReferencingSheet(
  xml: string,
  hostSheet: string,
  g: GlobalMaps,
  extendByCell: Map<string, ChangeSetExtendRange[]>,
): string {
  const ws = parseWorksheet(xml);
  const translate = makeTranslate(translateCtxFor(hostSheet, g));
  for (const row of ws.rows) {
    for (const c of row.cells) {
      c.raw = rewriteCellFormula(c.raw, (f) => {
        const t = translate(f);
        const ext = extendByCell.get(`${hostSheet}!${c.ref}`);
        return ext ? applyExtendToFormula(t, ext) : t;
      });
    }
  }
  return emitWorksheet(ws);
}

export { resolveCompareOptions };
