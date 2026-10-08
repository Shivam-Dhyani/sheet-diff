/** CSV intake: encoding + delimiter detection and RFC 4180 parsing (TDD §7.1 step 3). */

export type CsvEncoding = 'utf-8' | 'windows-1252';
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

export interface CsvParseResult {
  rows: string[][];
  delimiter: CsvDelimiter;
  encoding: CsvEncoding;
}

const BOM = [0xef, 0xbb, 0xbf];

export function detectEncoding(bytes: Uint8Array): CsvEncoding {
  if (bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) {
    return 'utf-8';
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

function decode(bytes: Uint8Array, encoding: CsvEncoding): string {
  const text = new TextDecoder(encoding).decode(bytes);
  // Strip a leading BOM if present.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Score delimiters by consistency of field counts across the first 50 lines:
 * the delimiter with mode field-count > 1 and the lowest variance wins
 * (TDD §7.1 step 3).
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.length > 0).slice(0, 50);
  let best: CsvDelimiter = ',';
  let bestScore = -Infinity;
  for (const d of CSV_DELIMITERS) {
    const counts = lines.map((line) => countTopLevel(line, d));
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    let mode = 0;
    let modeFreq = 0;
    for (const [val, f] of freq) {
      if (f > modeFreq || (f === modeFreq && val > mode)) {
        mode = val;
        modeFreq = f;
      }
    }
    if (mode < 1) continue; // need at least one delimiter per line
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    // Higher mode (more columns) and lower variance are better.
    const score = modeFreq * 1000 + mode * 10 - variance;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Count delimiters outside quoted spans on a single line. */
function countTopLevel(line: string, d: string): number {
  let n = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && ch === d) {
      n++;
    }
  }
  return n;
}

/** Full RFC 4180 parse into rows of fields. */
export function parseCsvText(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r') {
      // handle \r\n and lone \r
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      i += text[i + 1] === '\n' ? 2 : 1;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  // flush trailing field/row (unless it's a single empty field from a trailing newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseCsv(
  bytes: Uint8Array,
  opts?: { delimiter?: string; encoding?: CsvEncoding },
): CsvParseResult {
  const encoding = opts?.encoding ?? detectEncoding(bytes);
  const text = decode(bytes, encoding);
  const delimiter = (opts?.delimiter as CsvDelimiter | undefined) ?? detectDelimiter(text);
  const rows = parseCsvText(text, delimiter);
  return { rows, delimiter, encoding };
}

/**
 * Classify a raw CSV token as a number when the whole string is numeric.
 * Accepts Indian (`1,23,456.78`) and Western (`123,456.78`) grouping; rejects
 * leading-zero runs like `00123` (kept as text). Returns `null` when not numeric.
 */
export function parseCsvNumber(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  // Optional sign, digit groups, optional decimal, optional exponent.
  // Reject strings with a leading zero followed by another digit (e.g. 00123, 0123).
  const numeric = /^[+-]?(\d{1,3}(,\d{2,3})*(\.\d+)?|\d+(\.\d+)?)([eE][+-]?\d+)?$/;
  if (!numeric.test(s)) return null;
  const digitsOnly = s.replace(/^[+-]/, '');
  if (/^0\d/.test(digitsOnly)) return null; // leading zero run → text
  const normalized = s.replace(/,/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
