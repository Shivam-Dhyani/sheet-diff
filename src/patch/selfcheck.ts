import { CellKind, type WorkbookIR } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import { resolveCompareOptions, type CompareOptions } from '../options.js';
import { SheetDiffError } from '../errors.js';
import type { MergeChangeSet } from '../merge/types.js';
import { sheetMeta } from './apply.js';
import type { Scalar } from '../types.js';

function cellScalar(wb: WorkbookIR, sheetName: string, row0: number, col: number): Scalar {
  const sheet = wb.sheets.find((s) => s.name === sheetName);
  if (!sheet) return null;
  const c = getCell(sheet, wb.pool, row0, col);
  switch (c.kind) {
    case CellKind.Empty:
      return null;
    case CellKind.Number:
    case CellKind.DateSerial:
      return c.num;
    case CellKind.Boolean:
      return c.num !== 0;
    default:
      return c.text;
  }
}

const TOLERANCE = 0.01;
function eq(a: Scalar, b: Scalar): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= TOLERANCE;
  return String(a) === String(b);
}

/**
 * Self-check (TDD §10.9): re-read the patched output and confirm the applied
 * input-cell edits are present, inserted keys exist, deleted keys are gone, and
 * the row count matches base − deletes + inserts. Throws
 * `PATCH_SELFCHECK_FAILED` on any mismatch so nothing is downloaded.
 * (Formula cells are recalculated by Excel/LibreOffice on open, so their values
 * are not asserted here — only inputs and structure.)
 */
export function selfCheck(
  base: WorkbookIR,
  output: WorkbookIR,
  changeSet: MergeChangeSet,
  opts?: Partial<CompareOptions>,
): void {
  const options = resolveCompareOptions(opts);
  const fail = (msg: string, data: Record<string, unknown> = {}): never => {
    throw new SheetDiffError('PATCH_SELFCHECK_FAILED', `SheetLens could not write this file safely: ${msg}`, data);
  };

  // Per sheet: meta from the OUTPUT (post-merge layout) for key→row lookup.
  const outMetaBySheet = new Map<string, ReturnType<typeof sheetMeta>>();
  const metaForOutput = (sheetName: string): ReturnType<typeof sheetMeta> | undefined => {
    if (outMetaBySheet.has(sheetName)) return outMetaBySheet.get(sheetName);
    const sheet = output.sheets.find((s) => s.name === sheetName);
    if (!sheet) return undefined;
    const m = sheetMeta(sheet, output, options);
    outMetaBySheet.set(sheetName, m);
    return m;
  };

  for (const e of changeSet.cellEdits) {
    if (e.formula !== undefined) continue; // formula edits recalc on open
    const meta = metaForOutput(e.sheet);
    const row0 = meta?.keyRow.get(e.key);
    const col = meta?.headerToCol.get(e.column);
    if (row0 === undefined || col === undefined) fail(`edited cell ${e.key}/${e.column} not found`, { e });
    const got = cellScalar(output, e.sheet, row0!, col!);
    if (!eq(got, e.value ?? null)) fail(`edit ${e.key}/${e.column} = ${String(got)} ≠ ${String(e.value)}`);
  }

  for (const ins of changeSet.rowInserts) {
    const meta = metaForOutput(ins.sheet);
    if (!meta?.keyRow.has(ins.key)) fail(`inserted row ${ins.key} missing`);
  }
  for (const del of changeSet.rowDeletes) {
    const meta = metaForOutput(del.sheet);
    if (meta?.keyRow.has(del.key)) fail(`deleted row ${del.key} still present`);
  }

  // Row-count check per sheet.
  const bySheet = new Map<string, { ins: number; del: number }>();
  for (const i of changeSet.rowInserts) (bySheet.get(i.sheet) ?? bySheet.set(i.sheet, { ins: 0, del: 0 }).get(i.sheet)!).ins++;
  for (const d of changeSet.rowDeletes) (bySheet.get(d.sheet) ?? bySheet.set(d.sheet, { ins: 0, del: 0 }).get(d.sheet)!).del++;
  for (const [sheetName, { ins, del }] of bySheet) {
    const baseSheet = base.sheets.find((s) => s.name === sheetName);
    if (!baseSheet) continue;
    const baseMeta = sheetMeta(baseSheet, base, options);
    const outMeta = metaForOutput(sheetName);
    if (!outMeta) continue;
    const expected = baseMeta.keyRow.size - del + ins;
    if (outMeta.keyRow.size !== expected) {
      fail(`row count on ${sheetName} is ${outMeta.keyRow.size}, expected ${expected}`);
    }
  }
}
