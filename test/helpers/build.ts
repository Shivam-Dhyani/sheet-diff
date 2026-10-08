import * as XLSX from 'xlsx';

/** A cell: a primitive value, or a formula `{ f, v }` (f without leading '='). */
export type CellSpec = string | number | boolean | null | { f: string; v: number };

export interface SheetSpec {
  name: string;
  rows: CellSpec[][];
}

function toCellObject(spec: CellSpec): XLSX.CellObject | undefined {
  if (spec === null || spec === '') return undefined;
  if (typeof spec === 'object') return { t: 'n', f: spec.f, v: spec.v };
  if (typeof spec === 'number') return { t: 'n', v: spec };
  if (typeof spec === 'boolean') return { t: 'b', v: spec };
  return { t: 's', v: spec };
}

function buildWorksheet(rows: CellSpec[][]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const nRows = rows.length;
  const nCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < (rows[r]?.length ?? 0); c++) {
      const cell = toCellObject(rows[r]![c]!);
      if (!cell) continue;
      const addr = XLSX.utils.encode_cell({ r, c });
      ws[addr] = cell;
    }
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, nRows - 1), c: Math.max(0, nCols - 1) } });
  return ws;
}

/** Build an in-memory .xlsx (as bytes) from sheet specs. */
export function buildXlsx(sheets: SheetSpec[]): Uint8Array {
  const wb: XLSX.WorkBook = { SheetNames: [], Sheets: {} };
  for (const s of sheets) {
    wb.SheetNames.push(s.name);
    wb.Sheets[s.name] = buildWorksheet(s.rows);
  }
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(out as ArrayBuffer);
}

/** Build a CSV byte buffer. */
export function buildCsv(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
