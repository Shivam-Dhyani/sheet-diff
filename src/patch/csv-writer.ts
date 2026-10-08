import { type WorkbookIR } from '../ir/types.js';
import { resolveCompareOptions, type CompareOptions } from '../options.js';
import { parseCsv } from '../read/csv.js';
import { sheetMeta } from './apply.js';
import type { MergeChangeSet } from '../merge/types.js';
import { strToU8 } from 'fflate';

function csvField(v: string, delimiter: string): string {
  return /["\n\r]/.test(v) || v.includes(delimiter) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Rewrite a CSV original with the merged changes (FR-MRG-10): same delimiter,
 * encoding and quoting. Operates on the raw rows by key.
 */
export function writeMergedCsv(
  base: WorkbookIR,
  changeSet: MergeChangeSet,
  opts?: Partial<CompareOptions>,
): Uint8Array {
  if (!base.sourceBytes) throw new Error('CSV merge requires source bytes');
  const options = resolveCompareOptions(opts);
  const { rows, delimiter } = parseCsv(base.sourceBytes);
  const baseSheet = base.sheets[0]!;
  const meta = sheetMeta(baseSheet, base, options);
  const colOf = (header: string): number | undefined => meta.headerToCol.get(header);

  // cell edits
  for (const e of changeSet.cellEdits) {
    const r = meta.keyRow.get(e.key);
    const c = colOf(e.column);
    if (r === undefined || c === undefined) continue;
    const row = rows[r] ?? (rows[r] = []);
    row[c] = e.value === null || e.value === undefined ? '' : String(e.value);
  }
  // deletes (mark rows for removal by key)
  const deleteRowIdx = new Set<number>();
  for (const d of changeSet.rowDeletes) {
    const r = meta.keyRow.get(d.key);
    if (r !== undefined) deleteRowIdx.add(r);
  }
  // inserts: append after anchor
  const result: string[][] = [];
  for (let r = 0; r < rows.length; r++) {
    if (deleteRowIdx.has(r)) continue;
    result.push(rows[r]!);
    const key = meta.rowKeyMap.get(r);
    if (!key) continue;
    for (const ins of changeSet.rowInserts.filter((i) => i.afterKey === key)) {
      const row: string[] = [];
      for (const rc of ins.cells) {
        const c = colOf(rc.column);
        if (c !== undefined) row[c] = rc.value === null || rc.value === undefined ? '' : String(rc.value);
      }
      result.push(row);
    }
  }

  const text = result.map((row) => row.map((f) => csvField(f ?? '', delimiter)).join(delimiter)).join('\r\n');
  return strToU8(text);
}
