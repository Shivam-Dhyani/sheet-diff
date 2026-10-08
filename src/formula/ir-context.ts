import { CellKind, type WorkbookIR } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import type { EvalContext } from './evaluator.js';
import type { CellScalar } from './functions.js';

/** Build an {@link EvalContext} that reads a workbook's IR by sheet name. */
export function makeEvalContext(wb: WorkbookIR, defaultSheet: string): EvalContext {
  const byName = new Map(wb.sheets.map((s) => [s.name, s]));
  return {
    defaultSheet,
    sheetExists: (sheet) => byName.has(sheet),
    rowCount: (sheet) => byName.get(sheet)?.rows ?? 0,
    colCount: (sheet) => byName.get(sheet)?.cols ?? 0,
    getCell: (sheet, r, c): CellScalar => {
      const s = byName.get(sheet);
      if (!s) return null;
      const cell = getCell(s, wb.pool, r, c);
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
        case CellKind.String:
        default:
          return cell.text;
      }
    },
  };
}
