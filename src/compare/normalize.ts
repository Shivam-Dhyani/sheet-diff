import { CellKind, type Cell } from '../ir/types.js';
import type { CompareOptions } from '../options.js';
import { parseTextDate, serialToYmd, ymdKey } from './dates.js';

/** Normalize a string for comparison/keys (NFC + optional case/space handling). */
export function normalizeString(s: string, opts: Pick<CompareOptions, 'ignoreCase' | 'ignoreSpaces'>): string {
  let out = s.normalize('NFC');
  if (opts.ignoreSpaces) out = out.replace(/\s+/g, ' ').trim();
  else out = out.trim();
  if (opts.ignoreCase) out = out.toLowerCase();
  return out;
}

export function numbersEqual(a: number, b: number, tolerance: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return Math.abs(a - b) <= tolerance;
}

/** Does this text look like a number that groups as 1,23,456.78 / 123,456.78? */
const NUMERIC_TEXT = /^[+-]?(\d{1,3}(,\d{2,3})*(\.\d+)?|\d+(\.\d+)?)$/;

export function parseNumericText(text: string): number | null {
  const s = text.trim();
  if (!NUMERIC_TEXT.test(s)) return null;
  const digits = s.replace(/^[+-]/, '');
  if (/^0\d/.test(digits)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * A canonical comparison token for a cell. Used by hashing and key building so
 * that equal values (per options) collapse to the same string.
 */
export function cellToken(cell: Cell, opts: CompareOptions): string {
  switch (cell.kind) {
    case CellKind.Empty:
      return '';
    case CellKind.Number:
      return `n:${roundForKey(cell.num, opts.numericTolerance)}`;
    case CellKind.DateSerial:
      return `d:${cell.num}`;
    case CellKind.Boolean:
      return `b:${cell.num ? 1 : 0}`;
    case CellKind.Error:
      return `e:${cell.text}`;
    case CellKind.String:
    default:
      return `s:${normalizeString(cell.text, opts)}`;
  }
}

/** Quantize a number to the tolerance grid so near-equal numbers hash the same. */
function roundForKey(n: number, tolerance: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (tolerance <= 0) return String(n);
  return String(Math.round(n / tolerance));
}

export type CellEquality = 'equal' | 'type_changed' | 'different';

/**
 * Value-level equality honouring BR-C4 (numeric tolerance) and BR-C5 (text
 * dates ≡ real dates → reported as type_changed). Formula-awareness lives in
 * the cell comparator; this handles plain values.
 */
export function compareValues(
  oldCell: Cell,
  newCell: Cell,
  date1904Old: boolean,
  date1904New: boolean,
  opts: CompareOptions,
): CellEquality {
  const a = oldCell;
  const b = newCell;

  // Both numeric (number/boolean/date serial treated via num).
  const aNum = numericValue(a);
  const bNum = numericValue(b);

  if (aNum !== null && bNum !== null) {
    // date-serial vs number: compare by value; type differs only if kinds differ
    const equal = numbersEqual(aNum, bNum, opts.numericTolerance);
    if (!equal) return 'different';
    return a.kind === b.kind ? 'equal' : 'type_changed';
  }

  // numeric ↔ numeric-looking text
  if (aNum !== null && b.kind === CellKind.String) {
    const bn = parseNumericText(b.text);
    if (bn !== null) return numbersEqual(aNum, bn, opts.numericTolerance) ? 'type_changed' : 'different';
  }
  if (bNum !== null && a.kind === CellKind.String) {
    const an = parseNumericText(a.text);
    if (an !== null) return numbersEqual(an, bNum, opts.numericTolerance) ? 'type_changed' : 'different';
  }

  // date-serial ↔ text date (BR-C5)
  if (opts.textDatesEqual) {
    if (a.kind === CellKind.DateSerial && b.kind === CellKind.String) {
      const bd = parseTextDate(b.text, opts.dateOrder);
      if (bd && ymdKey(serialToYmd(a.num, date1904Old)) === ymdKey(bd)) return 'type_changed';
    }
    if (b.kind === CellKind.DateSerial && a.kind === CellKind.String) {
      const ad = parseTextDate(a.text, opts.dateOrder);
      if (ad && ymdKey(serialToYmd(b.num, date1904New)) === ymdKey(ad)) return 'type_changed';
    }
    // both text dates
    if (a.kind === CellKind.String && b.kind === CellKind.String) {
      const ad = parseTextDate(a.text, opts.dateOrder);
      const bd = parseTextDate(b.text, opts.dateOrder);
      if (ad && bd) return ymdKey(ad) === ymdKey(bd) ? 'equal' : 'different';
    }
  }

  // errors
  if (a.kind === CellKind.Error || b.kind === CellKind.Error) {
    return a.kind === CellKind.Error && b.kind === CellKind.Error && a.text === b.text
      ? 'equal'
      : 'different';
  }

  // plain strings
  if (a.kind === CellKind.String && b.kind === CellKind.String) {
    return normalizeString(a.text, opts) === normalizeString(b.text, opts) ? 'equal' : 'different';
  }

  // empty vs empty
  if (a.kind === CellKind.Empty && b.kind === CellKind.Empty) return 'equal';

  return 'different';
}

/** Numeric value for number/boolean/date-serial kinds, else null. */
export function numericValue(cell: Cell): number | null {
  if (cell.kind === CellKind.Number || cell.kind === CellKind.Boolean || cell.kind === CellKind.DateSerial) {
    return cell.num;
  }
  return null;
}
