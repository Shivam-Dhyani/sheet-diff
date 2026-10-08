import { colToLetter } from '../ir/coords.js';
import { xmlEscape } from './zip.js';
import type { WsRow, WsCell } from './worksheet.js';
import { serialFromYmd } from './serial.js';
import type { Scalar } from '../types.js';

/** Extract the style index (`s="N"`) from a cell's raw XML. */
export function styleOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return /\bs="(\d+)"/.exec(raw)?.[1];
}

export interface CellWrite {
  value?: Scalar;
  formula?: string;
  /** Computed value to cache alongside a formula (optional). */
  computed?: number | undefined;
}

function styleAttr(s: string | undefined): string {
  return s !== undefined ? ` s="${s}"` : '';
}

/** Build a cell's XML for a write, keeping the style `s`. */
export function buildCell(ref: string, write: CellWrite, style: string | undefined): string {
  const s = styleAttr(style);
  if (write.formula !== undefined) {
    const v = write.computed !== undefined ? `<v>${write.computed}</v>` : '';
    return `<c r="${ref}"${s}><f>${xmlEscape(write.formula)}</f>${v}</c>`;
  }
  const value = write.value ?? null;
  if (value === null) return `<c r="${ref}"${s}/>`;
  if (typeof value === 'number') {
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  // string → inline string (avoids touching sharedStrings, TDD §10.3)
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

/** A date written as an Excel serial, keeping the cell's date style. */
export function buildDateCell(
  ref: string,
  y: number,
  m: number,
  d: number,
  style: string | undefined,
  date1904: boolean,
): string {
  const serial = serialFromYmd(y, m, d, date1904);
  return `<c r="${ref}"${styleAttr(style)}><v>${serial}</v></c>`;
}

/**
 * Set (or create) a cell in a row, in ascending column order. Reuses the
 * existing cell's style; for a new cell it takes the style from the nearest
 * populated cell above in the same column, falling back to `fallbackStyle`.
 */
export function setCell(
  row: WsRow,
  col: number,
  write: CellWrite,
  fallbackStyle: string | undefined,
): void {
  const ref = `${colToLetter(col)}${row.index}`;
  const existingIdx = row.cells.findIndex((c) => c.col === col);
  const style = existingIdx >= 0 ? styleOf(row.cells[existingIdx]!.raw) : fallbackStyle;
  const cell: WsCell = { ref, col, raw: buildCell(ref, write, style) };
  if (existingIdx >= 0) {
    row.cells[existingIdx] = cell;
  } else {
    let insertAt = row.cells.findIndex((c) => c.col > col);
    if (insertAt < 0) insertAt = row.cells.length;
    row.cells.splice(insertAt, 0, cell);
  }
}

/** The style of a column in a reference row (for styling inserted cells). */
export function columnStyle(row: WsRow | undefined, col: number): string | undefined {
  if (!row) return undefined;
  const c = row.cells.find((x) => x.col === col);
  return styleOf(c?.raw);
}
