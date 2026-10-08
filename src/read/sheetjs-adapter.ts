import * as XLSX from 'xlsx';
import type { WorkbookFormat } from '../ir/types.js';
import { createSheet, SheetBuilder } from '../ir/sheet.js';
import { createStringPool } from '../ir/string-pool.js';
import type { WorkbookIR, SheetIR, StringPool, MergeRange } from '../ir/types.js';
import { emptyFeatureInventory } from '../ir/types.js';
import type { Progress, AbortFlag } from '../options.js';
import { SheetDiffError } from '../errors.js';

export interface AdapterOptions {
  fileName: string;
  format: WorkbookFormat;
  valuesOnly: boolean;
  compareNumberFormats: boolean;
  onProgress?: (p: Progress) => void;
  signal?: AbortFlag;
}

const A1_ADDR_RE = /^[A-Z]+[0-9]+$/;

function checkAbort(signal?: AbortFlag): void {
  if (signal?.aborted) throw new SheetDiffError('ABORTED', 'Reading was cancelled.');
}

/** Is a SheetJS number-format string a date/time format? */
function isDateFormat(z: unknown): boolean {
  if (typeof z !== 'string' || z === '') return false;
  try {
    return XLSX.SSF.is_date(z);
  } catch {
    return false;
  }
}

/**
 * Parse raw bytes with SheetJS (dense mode) and convert one sheet at a time
 * into the compact IR, releasing each SheetJS sheet immediately after
 * conversion (TDD §7.1 step 4, §13).
 */
export function readWithSheetJs(bytes: Uint8Array, opts: AdapterOptions): WorkbookIR {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, {
      type: 'array',
      // NOTE: sparse read. SheetJS 0.18.5 (npm registry) represents dense rows
      // under numeric keys on the worksheet rather than the '!data' array that
      // 0.20 (CDN) uses; the adapter supports the '!data' form too, so when the
      // dependency is bumped to the CDN build, flip this to `dense: true`.
      // See IMPLEMENTATION_NOTES.md.
      dense: false,
      cellFormula: !opts.valuesOnly,
      cellNF: opts.compareNumberFormats,
      cellDates: false,
      cellStyles: false,
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/password|encrypt/i.test(msg)) {
      throw new SheetDiffError('PASSWORD_REQUIRED', 'This file is password-protected.');
    }
    throw new SheetDiffError('CORRUPT_FILE', 'This file could not be read.', { cause: msg });
  }

  const pool = createStringPool();
  const sheets: SheetIR[] = [];
  const names = wb.SheetNames;
  const date1904 = Boolean(wb.Workbook?.WBProps?.date1904);

  for (let si = 0; si < names.length; si++) {
    checkAbort(opts.signal);
    const name = names[si]!;
    opts.onProgress?.({
      phase: 'parse',
      message: `Reading sheet ${si + 1} of ${names.length}…`,
      ...(names.length > 0 ? { fraction: si / names.length } : {}),
    });
    const ws = wb.Sheets[name];
    if (ws) {
      sheets.push(convertSheet(name, ws, pool, opts));
    } else {
      sheets.push(createSheet(name, 0, 0));
    }
    // Release the SheetJS object for this sheet before moving on.
    delete wb.Sheets[name];
  }

  const meta: WorkbookIR['meta'] = {};
  const lastBy = wb.Props?.LastAuthor;
  const modified = wb.Props?.ModifiedDate;
  if (typeof lastBy === 'string') meta.lastModifiedBy = lastBy;
  if (modified instanceof Date) meta.modified = modified.toISOString();

  return {
    fileName: opts.fileName,
    format: opts.format,
    date1904,
    pool,
    sheets,
    meta,
    features: emptyFeatureInventory(),
  };
}

function convertSheet(
  name: string,
  ws: XLSX.WorkSheet,
  pool: StringPool,
  opts: AdapterOptions,
): SheetIR {
  const ref = ws['!ref'];
  if (!ref) return createSheet(name, 0, 0);
  const range = XLSX.utils.decode_range(ref);
  const rows = range.e.r + 1;
  const cols = range.e.c + 1;
  const sheet = createSheet(name, rows, cols);
  const b = new SheetBuilder(sheet, pool);

  // SheetJS ≥ 0.20 dense mode stores a 2D array under '!data'. The npm-registry
  // CE build (0.18.5) is sparse (address-keyed), so support both (see
  // IMPLEMENTATION_NOTES.md).
  const data = (ws as unknown as { ['!data']?: XLSX.CellObject[][] })['!data'];

  if (Array.isArray(data)) {
    for (let r = 0; r < rows; r++) {
      if (r % 10000 === 0) {
        checkAbort(opts.signal);
        if (r > 0) opts.onProgress?.({ phase: 'parse', message: `Reading ${name}: ${r} rows…` });
      }
      const rowArr = data[r];
      if (!rowArr) continue;
      for (let c = 0; c < cols; c++) {
        const cell = rowArr[c];
        if (!cell) continue;
        setFromCell(b, r, c, cell, opts);
      }
    }
  } else {
    // Sparse: iterate only the A1-addressed cells present.
    let processed = 0;
    for (const addr in ws) {
      if (!A1_ADDR_RE.test(addr)) continue; // skip '!ref', numeric dense keys, etc.
      const { r, c } = XLSX.utils.decode_cell(addr);
      if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
      setFromCell(b, r, c, ws[addr] as XLSX.CellObject, opts);
      if (++processed % 50000 === 0) checkAbort(opts.signal);
    }
  }

  const merges = ws['!merges'];
  if (merges) {
    for (const m of merges) {
      sheet.merges.push([m.s.r, m.s.c, m.e.r, m.e.c] as MergeRange);
    }
  }
  return sheet;
}

function setFromCell(
  b: SheetBuilder,
  r: number,
  c: number,
  cell: XLSX.CellObject,
  opts: AdapterOptions,
): void {
  const hasValue = !(cell.t === 'z' || cell.v === undefined || cell.v === null);
  if (!hasValue) {
    // A formula-only cell still carries its formula text.
    if (!opts.valuesOnly && cell.f) b.setFormula(r, c, String(cell.f));
    return;
  }
  convertCell(b, r, c, cell, opts);
}

function convertCell(
  b: SheetBuilder,
  r: number,
  c: number,
  cell: XLSX.CellObject,
  opts: AdapterOptions,
): void {
  switch (cell.t) {
    case 'n': {
      const v = typeof cell.v === 'number' ? cell.v : Number(cell.v);
      if (!opts.valuesOnly && isDateFormat(cell.z)) b.setDate(r, c, v);
      else b.setNumber(r, c, v);
      break;
    }
    case 'b':
      b.setBoolean(r, c, Boolean(cell.v));
      break;
    case 'e':
      b.setError(r, c, typeof cell.w === 'string' ? cell.w : String(cell.v));
      break;
    case 's':
    default:
      b.setString(r, c, String(cell.v));
      break;
  }
  if (!opts.valuesOnly && cell.f) b.setFormula(r, c, String(cell.f));
  if (opts.compareNumberFormats && typeof cell.z === 'string') b.setNumFmt(r, c, cell.z);
}
