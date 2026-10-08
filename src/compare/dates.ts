import type { DateOrder } from '../options.js';

export interface Ymd {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

const MS_PER_DAY = 86400000;
const EPOCH_1900 = Date.UTC(1899, 11, 30); // Excel 1900 system (with the historical leap bug for serial ≤ 60)
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/** Excel serial number → calendar date (UTC-based), honouring the 1904 system. */
export function serialToYmd(serial: number, date1904: boolean): Ymd {
  const base = date1904 ? EPOCH_1904 : EPOCH_1900;
  const ms = base + Math.round(serial) * MS_PER_DAY;
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function valid(y: number, m: number, d: number): Ymd | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  if (d > dim) return null;
  return { y, m, d };
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function fullYear(y: number): number {
  if (y >= 100) return y;
  // 2-digit years: 00-69 → 2000s, 70-99 → 1900s (common spreadsheet convention).
  return y <= 69 ? 2000 + y : 1900 + y;
}

/**
 * Parse a text date in the accepted formats (BR-C5):
 * DD-MM-YYYY, DD/MM/YYYY, DD-Mon-YYYY, YYYY-MM-DD. Numeric day/month ambiguity
 * is resolved by `dateOrder`. Returns `null` when the text is not a valid date.
 */
export function parseTextDate(text: string, dateOrder: DateOrder): Ymd | null {
  const s = text.trim();
  if (s === '') return null;

  // ISO: YYYY-MM-DD or YYYY/MM/DD
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));

  // DD-Mon-YYYY (month name)
  m = /^(\d{1,2})[-/ ]([A-Za-z]{3,4})[-/ ](\d{2,4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase()];
    if (mon) return valid(fullYear(Number(m[3])), mon, Number(m[1]));
    return null;
  }

  // Mon-DD-YYYY (month name first)
  m = /^([A-Za-z]{3,4})[-/ ](\d{1,2})[-/ ](\d{2,4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1]!.toLowerCase()];
    if (mon) return valid(fullYear(Number(m[3])), mon, Number(m[2]));
    return null;
  }

  // Numeric D/M/Y or M/D/Y by dateOrder
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(Number(m[3]));
    if (dateOrder === 'MDY') return valid(y, a, b);
    return valid(y, b, a); // DMY (default) and YMD-with-2-leading fall here
  }
  return null;
}

/** Canonical comparison key for a date. */
export function ymdKey(ymd: Ymd): string {
  return `${ymd.y}-${String(ymd.m).padStart(2, '0')}-${String(ymd.d).padStart(2, '0')}`;
}
