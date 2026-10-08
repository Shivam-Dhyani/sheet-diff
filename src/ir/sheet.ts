import { CellKind, type Cell, type SheetIR, type StringPool, type MergeRange } from './types.js';
import { cellIndex } from './coords.js';

/** Allocate an empty SheetIR of the given used-range size. */
export function createSheet(name: string, rows: number, cols: number): SheetIR {
  const size = Math.max(0, rows * cols);
  return {
    name,
    rows,
    cols,
    kind: new Uint8Array(size),
    num: new Float64Array(size).fill(NaN),
    str: new Uint32Array(size),
    formula: new Map<number, number>(),
    numFmt: null,
    merges: [] as MergeRange[],
  };
}

/** Read a single cell out of the columnar arrays. */
export function getCell(sheet: SheetIR, pool: StringPool, r: number, c: number): Cell {
  if (r < 0 || c < 0 || r >= sheet.rows || c >= sheet.cols) {
    return { kind: CellKind.Empty, num: NaN, text: '' };
  }
  const i = cellIndex(r, c, sheet.cols);
  const kind = sheet.kind[i] as CellKind;
  const num = sheet.num[i]!;
  const strId = sheet.str[i]!;
  const text = strId !== 0 ? pool.get(strId) : '';
  const cell: Cell = { kind, num, text };
  const fId = sheet.formula.get(i);
  if (fId !== undefined) cell.formula = pool.get(fId);
  if (sheet.numFmt) {
    const nfId = sheet.numFmt.get(i);
    if (nfId !== undefined) cell.numFmt = pool.get(nfId);
  }
  return cell;
}

/** Does the cell at (r, c) hold nothing (empty kind and no formula)? */
export function isEmpty(sheet: SheetIR, r: number, c: number): boolean {
  if (r < 0 || c < 0 || r >= sheet.rows || c >= sheet.cols) return true;
  const i = cellIndex(r, c, sheet.cols);
  return sheet.kind[i] === CellKind.Empty && !sheet.formula.has(i);
}

/** True when every cell in the row (within used cols) is empty. */
export function isRowEmpty(sheet: SheetIR, r: number): boolean {
  for (let c = 0; c < sheet.cols; c++) {
    if (!isEmpty(sheet, r, c)) return false;
  }
  return true;
}

/**
 * A light mutable builder so readers can fill cells one at a time without
 * touching the arrays directly.
 */
export class SheetBuilder {
  constructor(
    readonly sheet: SheetIR,
    private readonly pool: StringPool,
  ) {}

  setNumber(r: number, c: number, value: number): void {
    const i = cellIndex(r, c, this.sheet.cols);
    this.sheet.kind[i] = CellKind.Number;
    this.sheet.num[i] = value;
  }

  setDate(r: number, c: number, serial: number): void {
    const i = cellIndex(r, c, this.sheet.cols);
    this.sheet.kind[i] = CellKind.DateSerial;
    this.sheet.num[i] = serial;
  }

  setBoolean(r: number, c: number, value: boolean): void {
    const i = cellIndex(r, c, this.sheet.cols);
    this.sheet.kind[i] = CellKind.Boolean;
    this.sheet.num[i] = value ? 1 : 0;
  }

  setString(r: number, c: number, value: string): void {
    const i = cellIndex(r, c, this.sheet.cols);
    this.sheet.kind[i] = CellKind.String;
    this.sheet.str[i] = this.pool.intern(value);
  }

  setError(r: number, c: number, code: string): void {
    const i = cellIndex(r, c, this.sheet.cols);
    this.sheet.kind[i] = CellKind.Error;
    this.sheet.str[i] = this.pool.intern(code);
  }

  setFormula(r: number, c: number, formula: string): void {
    const i = cellIndex(r, c, this.sheet.cols);
    this.sheet.formula.set(i, this.pool.intern(formula));
  }

  setNumFmt(r: number, c: number, fmt: string): void {
    if (!this.sheet.numFmt) this.sheet.numFmt = new Map<number, number>();
    const i = cellIndex(r, c, this.sheet.cols);
    this.sheet.numFmt.set(i, this.pool.intern(fmt));
  }
}
