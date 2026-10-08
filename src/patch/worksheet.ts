import { letterToCol, colToLetter } from '../ir/coords.js';

export interface WsCell {
  /** A1 ref, e.g. "K18". */
  ref: string;
  col: number; // 0-based
  /** Full cell XML (self-closing or with children). */
  raw: string;
}

export interface WsRow {
  index: number; // 1-based row number
  /** The `<row ...>` opening tag (or the whole self-closing tag). */
  openTag: string;
  selfClosing: boolean;
  cells: WsCell[];
}

export interface Worksheet {
  head: string; // up to and including the <sheetData> open tag
  tail: string; // from </sheetData> to end
  rows: WsRow[];
  /** True when the sheet had a self-closing <sheetData/>. */
  emptyData: boolean;
}

const A1_RE = /^([A-Za-z]+)(\d+)$/;

function colOf(ref: string): number {
  const m = A1_RE.exec(ref);
  return m ? letterToCol(m[1]!.toUpperCase()) : 0;
}

/** Parse a worksheet XML into head / rows / tail (TDD §10.1 span model). */
export function parseWorksheet(xml: string): Worksheet {
  const selfClosed = /<sheetData\s*\/>/.exec(xml);
  if (selfClosed) {
    const idx = selfClosed.index + selfClosed[0].length;
    return { head: xml.slice(0, idx), tail: xml.slice(idx), rows: [], emptyData: true };
  }
  const openM = /<sheetData\b[^>]*>/.exec(xml);
  if (!openM) {
    // No sheetData at all — treat whole doc as head with an empty data region.
    return { head: xml, tail: '', rows: [], emptyData: true };
  }
  const bodyStart = openM.index + openM[0].length;
  const closeIdx = xml.indexOf('</sheetData>', bodyStart);
  const body = xml.slice(bodyStart, closeIdx);
  const head = xml.slice(0, bodyStart);
  const tail = xml.slice(closeIdx);

  const rows: WsRow[] = [];
  const rowRe = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(body)) !== null) {
    const attrs = rm[1] ?? '';
    const selfClosing = rm[2] === '/>';
    const inner = selfClosing ? '' : (rm[3] ?? '');
    const index = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? '0');
    const openTag = selfClosing ? `<row${attrs}/>` : `<row${attrs}>`;
    const cells: WsCell[] = [];
    if (!selfClosing) {
      const cellRe = /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(inner)) !== null) {
        const raw = cm[0];
        const ref = /\br="([A-Za-z]+\d+)"/.exec(raw)?.[1] ?? '';
        cells.push({ ref, col: colOf(ref), raw });
      }
    }
    rows.push({ index, openTag, selfClosing, cells });
  }
  return { head, tail, rows, emptyData: false };
}

/** Rewrite the `r=` of a cell's raw XML to a new ref. */
export function retargetCell(raw: string, newRef: string): string {
  return raw.replace(/(<c\b[^>]*?\br=")[A-Za-z]+\d+(")/, `$1${newRef}$2`);
}

/** Rewrite a row's open tag `r=` to a new 1-based index. */
function retargetRowOpen(openTag: string, newIndex: number): string {
  if (/\br="\d+"/.test(openTag)) return openTag.replace(/(\br=")\d+(")/, `$1${newIndex}$2`);
  // Insert an r attribute right after <row.
  return openTag.replace(/^<row/, `<row r="${newIndex}"`);
}

/** Re-number a row (and all its cells) to a new 1-based index. */
export function renumberRow(row: WsRow, newIndex: number): WsRow {
  const openTag = retargetRowOpen(row.openTag, newIndex);
  const cells = row.cells.map((c) => {
    const newRef = `${colToLetter(c.col)}${newIndex}`;
    return { ...c, ref: newRef, raw: retargetCell(c.raw, newRef) };
  });
  return { ...row, index: newIndex, openTag, cells };
}

/** Serialize a worksheet back to XML. */
export function emitWorksheet(ws: Worksheet): string {
  if (ws.emptyData && ws.rows.length === 0) return ws.head + ws.tail;
  const body = ws.rows
    .map((r) => (r.selfClosing ? r.openTag : `${r.openTag}${r.cells.map((c) => c.raw).join('')}</row>`))
    .join('');
  return ws.head + body + ws.tail;
}

/** Column letter of a cell ref. */
export function refCol(ref: string): string {
  return A1_RE.exec(ref)?.[1]?.toUpperCase() ?? 'A';
}
