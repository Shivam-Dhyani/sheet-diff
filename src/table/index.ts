import { CellKind, type SheetIR, type StringPool } from '../ir/types.js';
import { getCell, isEmpty, isRowEmpty } from '../ir/sheet.js';
import { colToLetter } from '../ir/coords.js';

export interface DetectedColumn {
  index: number; // 0-based column
  header: string; // normalized display header (synthetic "Column X" if none)
  synthetic: boolean;
}

export interface TotalRow {
  r: number; // 0-based
  label: string;
}

export interface TableModel {
  headerRow: number; // 0-based; synthetic headers use the row just before dataStart
  headerless: boolean;
  dataStart: number; // 0-based inclusive
  dataEnd: number; // 0-based inclusive (−1 when no data)
  columns: DetectedColumn[];
  totals: TotalRow[];
}

/** BR-C8: a row whose first non-empty cell reads like a total label. */
export const TOTAL_RE = /^(grand\s+)?(sub\s*)?total\b/i;

export interface TableOverride {
  headerRow?: number;
  dataRange?: { start: number; end: number };
}

export function detectTable(sheet: SheetIR, pool: StringPool, override?: TableOverride): TableModel {
  if (sheet.rows === 0 || sheet.cols === 0) {
    return { headerRow: -1, headerless: true, dataStart: 0, dataEnd: -1, columns: [], totals: [] };
  }

  const headerRow = override?.headerRow ?? detectHeaderRow(sheet, pool);
  const headerless = headerRow < 0;
  const effectiveHeaderRow = headerless ? firstNonEmptyRow(sheet) - 1 : headerRow;

  let dataStart = override?.dataRange?.start ?? effectiveHeaderRow + 1;
  if (dataStart < 0) dataStart = 0;

  const { dataEnd, totals } = override?.dataRange
    ? { dataEnd: override.dataRange.end, totals: findTotals(sheet, pool, dataStart, override.dataRange.end) }
    : scanDataRange(sheet, pool, dataStart);

  const columns = detectColumns(sheet, pool, headerless ? -1 : headerRow, dataStart, dataEnd);
  return { headerRow: effectiveHeaderRow, headerless, dataStart, dataEnd, columns, totals };
}

function firstNonEmptyRow(sheet: SheetIR): number {
  for (let r = 0; r < sheet.rows; r++) if (!isRowEmpty(sheet, r)) return r;
  return 0;
}

function detectHeaderRow(sheet: SheetIR, pool: StringPool): number {
  const limit = Math.min(29, sheet.rows - 1);
  let best = -1;
  let bestScore = 0;
  for (let r = 0; r <= limit; r++) {
    let textCells = 0;
    let nonEmpty = 0;
    const values = new Set<string>();
    const headerCols: number[] = [];
    for (let c = 0; c < sheet.cols; c++) {
      const cell = getCell(sheet, pool, r, c);
      if (cell.kind === CellKind.Empty && !cell.formula) continue;
      nonEmpty++;
      if (cell.kind === CellKind.String) {
        textCells++;
        values.add(cell.text.trim().toLowerCase());
        headerCols.push(c);
      }
    }
    if (textCells < 2 || nonEmpty === 0) continue;
    const textRatio = textCells / nonEmpty;
    if (textRatio < 0.6) continue;
    const distinctRatio = values.size / textCells;
    const follow = followConsistency(sheet, r, headerCols);
    const score = textCells * distinctRatio * follow;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/** Share of header columns non-empty in at least 2 of the next 3 rows. */
function followConsistency(sheet: SheetIR, headerRow: number, cols: number[]): number {
  if (cols.length === 0) return 0;
  let consistent = 0;
  for (const c of cols) {
    let filled = 0;
    for (let k = 1; k <= 3; k++) {
      const r = headerRow + k;
      if (r < sheet.rows && !isEmpty(sheet, r, c)) filled++;
    }
    if (filled >= 2) consistent++;
  }
  return consistent / cols.length;
}

function scanDataRange(
  sheet: SheetIR,
  pool: StringPool,
  dataStart: number,
): { dataEnd: number; totals: TotalRow[] } {
  const totals: TotalRow[] = [];
  let dataEnd = dataStart - 1;
  let consecutiveEmpty = 0;
  for (let r = dataStart; r < sheet.rows; r++) {
    const firstText = firstNonEmptyText(sheet, pool, r);
    if (firstText !== null && TOTAL_RE.test(firstText)) {
      totals.push({ r, label: firstText });
      continue; // totals do not extend the data range
    }
    if (isRowEmpty(sheet, r)) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 2) break;
      continue;
    }
    consecutiveEmpty = 0;
    dataEnd = r;
  }
  return { dataEnd, totals };
}

function findTotals(sheet: SheetIR, pool: StringPool, start: number, end: number): TotalRow[] {
  const totals: TotalRow[] = [];
  for (let r = start; r <= Math.min(end, sheet.rows - 1); r++) {
    const firstText = firstNonEmptyText(sheet, pool, r);
    if (firstText !== null && TOTAL_RE.test(firstText)) totals.push({ r, label: firstText });
  }
  return totals;
}

function firstNonEmptyText(sheet: SheetIR, pool: StringPool, r: number): string | null {
  for (let c = 0; c < sheet.cols; c++) {
    const cell = getCell(sheet, pool, r, c);
    if (cell.kind === CellKind.Empty && !cell.formula) continue;
    if (cell.kind === CellKind.String) return cell.text.trim();
    return null; // first non-empty is non-text → not a total label row
  }
  return null;
}

function detectColumns(
  sheet: SheetIR,
  pool: StringPool,
  headerRow: number,
  dataStart: number,
  dataEnd: number,
): DetectedColumn[] {
  const columns: DetectedColumn[] = [];
  const dataRows = Math.max(0, dataEnd - dataStart + 1);
  for (let c = 0; c < sheet.cols; c++) {
    let header = '';
    if (headerRow >= 0) {
      const hc = getCell(sheet, pool, headerRow, c);
      if (hc.kind === CellKind.String) header = hc.text.trim();
    }
    if (header !== '') {
      columns.push({ index: c, header, synthetic: false });
      continue;
    }
    // No header text: include the column only if ≥ 20% of data rows have data.
    if (dataRows > 0) {
      let filled = 0;
      for (let r = dataStart; r <= dataEnd; r++) if (!isEmpty(sheet, r, c)) filled++;
      if (filled / dataRows >= 0.2) {
        columns.push({ index: c, header: `Column ${colToLetter(c)}`, synthetic: true });
      }
    }
  }
  return columns;
}
