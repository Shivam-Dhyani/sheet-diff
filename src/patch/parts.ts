import type { Parts } from './zip.js';
import { readText } from './zip.js';

export interface SheetRef {
  name: string;
  sheetId: string;
  rId: string;
  /** Worksheet part path, e.g. "xl/worksheets/sheet1.xml". */
  path: string;
}

export interface WorkbookParts {
  date1904: boolean;
  sheets: SheetRef[];
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Resolve workbook sheets → worksheet part paths via workbook.xml + rels. */
export function readWorkbookParts(parts: Parts): WorkbookParts {
  const workbook = readText(parts, 'xl/workbook.xml');
  const rels = readText(parts, 'xl/_rels/workbook.xml.rels');

  const ridToTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) {
      const t = target.replace(/^\//, '');
      ridToTarget.set(id, t.startsWith('xl/') ? t : `xl/${t}`);
    }
  }

  const sheets: SheetRef[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = m[0];
    const name = /\bname="([^"]+)"/.exec(tag)?.[1];
    const sheetId = /\bsheetId="([^"]+)"/.exec(tag)?.[1] ?? '';
    const rId = /\br:id="([^"]+)"/.exec(tag)?.[1] ?? '';
    const path = ridToTarget.get(rId);
    if (name && path) sheets.push({ name: decodeXml(name), sheetId, rId, path });
  }

  const date1904 = /\bdate1904="(1|true)"/.test(workbook);
  return { date1904, sheets };
}

/** Next free numeric suffix for a new worksheet part path and a fresh rId. */
export function nextWorksheetName(parts: Parts): string {
  let max = 0;
  for (const name of Object.keys(parts)) {
    const m = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `xl/worksheets/sheet${max + 1}.xml`;
}

export function nextRelId(rels: string): string {
  let max = 0;
  for (const m of rels.matchAll(/\bId="rId(\d+)"/g)) max = Math.max(max, Number(m[1]));
  return `rId${max + 1}`;
}

export function nextSheetId(workbook: string): number {
  let max = 0;
  for (const m of workbook.matchAll(/\bsheetId="(\d+)"/g)) max = Math.max(max, Number(m[1]));
  return max + 1;
}
