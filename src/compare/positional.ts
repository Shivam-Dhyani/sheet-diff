import { CellKind, type SheetIR, type StringPool } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import type { CompareOptions } from '../options.js';
import { compareValues } from './normalize.js';

/**
 * Positional baseline (TDD §7.8): the number of cells that differ at the *same*
 * address within the union of both used ranges. Used only for the contrast line
 * (FR-RES-01) — "a basic cell-by-cell compare would flag N cells".
 */
export function positionalBaseline(
  oldSheet: SheetIR,
  newSheet: SheetIR,
  oldPool: StringPool,
  newPool: StringPool,
  date1904Old: boolean,
  date1904New: boolean,
  opts: CompareOptions,
): number {
  const rows = Math.max(oldSheet.rows, newSheet.rows);
  const cols = Math.max(oldSheet.cols, newSheet.cols);
  let diff = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = getCell(oldSheet, oldPool, r, c);
      const b = getCell(newSheet, newPool, r, c);
      const aEmpty = a.kind === CellKind.Empty && a.formula === undefined;
      const bEmpty = b.kind === CellKind.Empty && b.formula === undefined;
      if (aEmpty && bEmpty) continue;
      if (aEmpty !== bEmpty) {
        diff++;
        continue;
      }
      // formula text difference counts at the positional level
      if (a.formula !== b.formula) {
        diff++;
        continue;
      }
      if (compareValues(a, b, date1904Old, date1904New, opts) !== 'equal') diff++;
    }
  }
  return diff;
}
