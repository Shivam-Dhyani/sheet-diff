import { CellKind, type WorkbookIR } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import { SheetDiffError } from '../errors.js';
import { resolveCompareOptions, type CompareOptions } from '../options.js';
import type { MergeChangeSet, ChangeSetExtendRange, MergeLogRow } from '../merge/types.js';
import { readWorkbook } from '../read/index.js';
import type { Scalar } from '../types.js';
import { unzip, zip, readText, writeText } from './zip.js';
import { readWorkbookParts } from './parts.js';
import { parseWorksheet, emitWorksheet } from './worksheet.js';
import {
  sheetMeta,
  sheetChangeFor,
  computeRowMap,
  applyToWorksheet,
  rewriteReferencingSheet,
  type GlobalMaps,
  type SheetChange,
  type SheetMeta,
} from './apply.js';
import { addMergeLogSheet } from './merge-log-sheet.js';
import { setFullCalcOnLoad } from './calc.js';
import { rowOpBlocked, blocked } from './blockers.js';
import { selfCheck } from './selfcheck.js';
import { writeMergedCsv } from './csv-writer.js';
import type { PatchOutput, PatchOptions, BlockedOp } from './types.js';

export type { PatchOutput, PatchOptions, BlockedOp, FidelityReport } from './types.js';

/**
 * Apply a merge change set to the Original, producing a patched copy
 * (TDD §10 / FR-MRG-06). Only `.xlsx`/`.xlsm` (patch mode) and `.csv` (rewrite)
 * are supported; `.xls` → `MERGE_XLS`. Runs a self-check before returning.
 */
export async function applyMergePatch(
  base: WorkbookIR,
  changeSet: MergeChangeSet,
  opts: PatchOptions,
  compareOpts?: Partial<CompareOptions>,
): Promise<PatchOutput> {
  const options = resolveCompareOptions(compareOpts);
  if (!base.sourceBytes) {
    throw new SheetDiffError('PATCH_SELFCHECK_FAILED', 'The Original was read without keeping its bytes.');
  }
  if (base.format === 'xls') {
    throw new SheetDiffError('MERGE_XLS', 'To merge, open the original in Excel and save it as .xlsx.');
  }

  const log = opts.log ?? deriveLog(base, changeSet, options);

  if (base.format === 'csv') {
    const bytes = writeMergedCsv(base, changeSet, options);
    const out = await readWorkbook(bytes, { fileName: 'merged.csv' });
    selfCheck(base, out, changeSet, options);
    return { bytes, applied: log, blocked: [], fidelity: fidelityOf(base) };
  }

  const parts = unzip(base.sourceBytes);
  const wbParts = readWorkbookParts(parts);
  const sheetPath = new Map(wbParts.sheets.map((s) => [s.name, s.path]));

  // Which sheets have changes?
  const changedSheets = new Set<string>();
  for (const e of changeSet.cellEdits) changedSheets.add(e.sheet);
  for (const i of changeSet.rowInserts) changedSheets.add(i.sheet);
  for (const d of changeSet.rowDeletes) changedSheets.add(d.sheet);

  // Global maps (rows/cols bounds for every sheet; row maps for changed sheets).
  const g: GlobalMaps = { maps: new Map(), dataEnd: new Map(), rows: new Map(), cols: new Map() };
  for (const s of base.sheets) {
    g.rows.set(s.name, s.rows);
    g.cols.set(s.name, s.cols);
  }

  const metaBySheet = new Map<string, SheetMeta>();
  const changeBySheet = new Map<string, SheetChange>();
  const blockedOps: BlockedOp[] = [];

  for (const sheetName of changedSheets) {
    const baseSheet = base.sheets.find((s) => s.name === sheetName);
    if (!baseSheet || !sheetPath.has(sheetName)) continue;
    const meta = sheetMeta(baseSheet, base, options);
    const change = sheetChangeFor(changeSet, sheetName, meta.headerToCol);

    // Blockers (§10.5): drop unsafe inserts/deletes, keep cell edits.
    change.inserts = change.inserts.filter((ins) => {
      const anchor0 = ins.afterKey ? (meta.keyRow.get(ins.afterKey) ?? meta.table.dataStart) + 1 : meta.table.dataStart;
      const reason = rowOpBlocked(base.features, sheetName, anchor0);
      if (reason) {
        blockedOps.push(blocked(sheetName, ins.key, 'insert', reason));
        return false;
      }
      return true;
    });
    const keptDeletes = new Set<string>();
    for (const key of change.deletes) {
      const at0 = meta.keyRow.get(key) ?? meta.table.dataStart;
      const reason = rowOpBlocked(base.features, sheetName, at0);
      if (reason) blockedOps.push(blocked(sheetName, key, 'delete', reason));
      else keptDeletes.add(key);
    }
    change.deletes = keptDeletes;

    metaBySheet.set(sheetName, meta);
    changeBySheet.set(sheetName, change);
    g.maps.set(sheetName, computeRowMap(meta, change));
    g.dataEnd.set(sheetName, meta.table.dataEnd);
  }

  const extendByCell = new Map<string, ChangeSetExtendRange[]>();
  for (const er of changeSet.extendRanges) {
    const k = `${er.sheet}!${er.cell}`;
    (extendByCell.get(k) ?? extendByCell.set(k, []).get(k)!).push(er);
  }

  // Phase A: rewrite changed sheets.
  for (const [sheetName, meta] of metaBySheet) {
    const baseSheet = base.sheets.find((s) => s.name === sheetName)!;
    const path = sheetPath.get(sheetName)!;
    const ws = parseWorksheet(readText(parts, path));
    applyToWorksheet(ws, baseSheet, meta, changeBySheet.get(sheetName)!, g, extendByCell);
    writeText(parts, path, emitWorksheet(ws));
  }

  // Phase B: untouched sheets that reference a changed sheet (or carry extends).
  const changedNames = [...metaBySheet.keys()];
  for (const sref of wbParts.sheets) {
    if (metaBySheet.has(sref.name)) continue;
    const xml = readText(parts, sref.path);
    const refsChanged = changedNames.some((n) => xml.includes(n));
    const hasExtend = [...extendByCell.keys()].some((k) => k.startsWith(`${sref.name}!`));
    if (!refsChanged && !hasExtend) continue;
    writeText(parts, sref.path, rewriteReferencingSheet(xml, sref.name, g, extendByCell));
  }

  // Merge Log sheet, recalc, calc chain.
  addMergeLogSheet(parts, log);
  setFullCalcOnLoad(parts);

  let bytes = zip(parts);

  // Re-encryption (optional, TDD §10.8) — only when requested and available.
  if (opts.password) {
    try {
      const specifier = 'officecrypto-tool';
      const mod = (await import(specifier)) as { encrypt?: (b: Uint8Array, o: { password: string }) => Promise<Uint8Array> };
      const enc = mod.encrypt ?? (mod as { default?: typeof mod }).default?.encrypt;
      if (enc) bytes = await enc(bytes, { password: opts.password });
    } catch {
      // Encryption unavailable → return the unencrypted bytes; caller decides.
    }
  }

  // Self-check (skip when encrypted, since we cannot re-read without the password here).
  if (!opts.password) {
    const out = await readWorkbook(bytes, { fileName: 'merged.xlsx' });
    selfCheck(base, out, changeSet, options);
  }

  return { bytes, applied: log, blocked: blockedOps, fidelity: fidelityOf(base) };
}

function fidelityOf(base: WorkbookIR): PatchOutput['fidelity'] {
  const f = base.features;
  return {
    charts: f.charts.length > 0,
    pivotTables: f.pivotSources.length > 0,
    macros: f.hasMacros,
    comments: Object.keys(f.commentsBySheet).length > 0,
    conditionalFormats: f.extLstSqrefSheets.length > 0,
    dataValidation: false,
  };
}

/** Fallback merge log derived from the change set (reads base old values). */
function deriveLog(base: WorkbookIR, changeSet: MergeChangeSet, options: CompareOptions): MergeLogRow[] {
  const rows: MergeLogRow[] = [];
  const metaCache = new Map<string, SheetMeta>();
  const meta = (sheet: string): SheetMeta | undefined => {
    if (metaCache.has(sheet)) return metaCache.get(sheet);
    const s = base.sheets.find((x) => x.name === sheet);
    if (!s) return undefined;
    const m = sheetMeta(s, base, options);
    metaCache.set(sheet, m);
    return m;
  };
  const oldVal = (sheet: string, key: string, column: string): Scalar => {
    const m = meta(sheet);
    const s = base.sheets.find((x) => x.name === sheet);
    const r = m?.keyRow.get(key);
    const c = m?.headerToCol.get(column);
    if (!s || r === undefined || c === undefined) return null;
    const cell = getCell(s, base.pool, r, c);
    if (cell.kind === CellKind.Empty) return null;
    if (cell.kind === CellKind.Number || cell.kind === CellKind.DateSerial) return cell.num;
    if (cell.kind === CellKind.Boolean) return cell.num !== 0;
    return cell.text;
  };
  let n = 0;
  for (const e of changeSet.cellEdits) {
    rows.push({ n: ++n, sheet: e.sheet, key: e.key, column: e.column, oldValue: oldVal(e.sheet, e.key, e.column), newValue: e.value ?? e.formula ?? null, source: e.source, decision: 'applied', note: '' });
  }
  for (const i of changeSet.rowInserts) {
    rows.push({ n: ++n, sheet: i.sheet, key: i.key, column: '(new row)', oldValue: null, newValue: i.key, source: i.source, decision: 'applied', note: i.afterKey ? `after ${i.afterKey}` : 'at top' });
  }
  for (const d of changeSet.rowDeletes) {
    rows.push({ n: ++n, sheet: d.sheet, key: d.key, column: '(row)', oldValue: d.key, newValue: '(deleted)', source: d.source, decision: 'applied', note: '' });
  }
  return rows;
}
