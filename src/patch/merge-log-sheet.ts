import type { Parts } from './zip.js';
import { readText, writeText, xmlEscape } from './zip.js';
import { nextWorksheetName, nextRelId, nextSheetId } from './parts.js';
import type { MergeLogRow } from '../merge/types.js';
import type { Scalar } from '../types.js';
import { colToLetter } from '../ir/coords.js';

const HEADERS = ['#', 'Sheet', 'Row key', 'Column', 'Old value', 'New value', 'Source', 'Decision', 'Note'];

function cell(ref: string, value: Scalar | number): string {
  if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
  if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
}

function row(r: number, values: (Scalar | number)[]): string {
  const cells = values.map((v, i) => cell(`${colToLetter(i)}${r}`, v)).join('');
  return `<row r="${r}">${cells}</row>`;
}

function buildSheetXml(rows: MergeLogRow[]): string {
  const body: string[] = [];
  body.push(row(1, HEADERS));
  rows.forEach((lr, i) => {
    body.push(
      row(i + 2, [lr.n, lr.sheet, lr.key, lr.column, lr.oldValue, lr.newValue, lr.source, lr.decision, lr.note]),
    );
  });
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:${colToLetter(HEADERS.length - 1)}${rows.length + 1}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols><col min="1" max="1" width="5"/><col min="2" max="4" width="16"/><col min="5" max="6" width="20"/><col min="7" max="9" width="16"/></cols>` +
    `<sheetData>${body.join('')}</sheetData>` +
    `</worksheet>`
  );
}

/** A unique sheet name (append " (2)" etc. if "SheetLens Merge Log" is taken). */
function uniqueName(workbook: string, base: string): string {
  const existing = new Set([...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}

/**
 * Append a "SheetLens Merge Log" worksheet (TDD §10.6): new part, workbook
 * `<sheet>`, rels relationship, `[Content_Types]` override, and docProps/app.xml
 * counts.
 */
export function addMergeLogSheet(parts: Parts, rows: MergeLogRow[]): void {
  const path = nextWorksheetName(parts); // e.g. xl/worksheets/sheet3.xml
  const base = path.replace(/^xl\//, ''); // worksheets/sheet3.xml
  writeText(parts, path, buildSheetXml(rows));

  // workbook.xml.rels
  const relsPath = 'xl/_rels/workbook.xml.rels';
  let rels = readText(parts, relsPath);
  const rId = nextRelId(rels);
  rels = rels.replace(
    /<\/Relationships>/,
    `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${base}"/></Relationships>`,
  );
  writeText(parts, relsPath, rels);

  // workbook.xml <sheets>
  let workbook = readText(parts, 'xl/workbook.xml');
  const name = uniqueName(workbook, 'SheetLens Merge Log');
  const sheetId = nextSheetId(workbook);
  workbook = workbook.replace(
    /<\/sheets>/,
    `<sheet name="${xmlEscape(name)}" sheetId="${sheetId}" state="visible" r:id="${rId}"/></sheets>`,
  );
  writeText(parts, 'xl/workbook.xml', workbook);

  // [Content_Types].xml override
  const ctPath = '[Content_Types].xml';
  let ct = readText(parts, ctPath);
  ct = ct.replace(
    /<\/Types>/,
    `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  );
  writeText(parts, ctPath, ct);

  // docProps/app.xml — bump TitlesOfParts/HeadingPairs if present.
  const appPath = 'docProps/app.xml';
  const app = readText(parts, appPath);
  if (app) writeText(parts, appPath, bumpAppXml(app, name));
}

function bumpAppXml(app: string, sheetName: string): string {
  let out = app;
  // TitlesOfParts vector size + append a vt:lpstr
  out = out.replace(
    /(<TitlesOfParts><vt:vector size=")(\d+)("[^>]*>)([\s\S]*?)(<\/vt:vector><\/TitlesOfParts>)/,
    (_f, a, size, b, items, c) =>
      `${a}${Number(size) + 1}${b}${items}<vt:lpstr>${xmlEscape(sheetName)}</vt:lpstr>${c}`,
  );
  // HeadingPairs "Worksheets" count + 1
  out = out.replace(
    /(<vt:lpstr>Worksheets<\/vt:lpstr><\/vt:variant><vt:variant><vt:i4>)(\d+)(<\/vt:i4>)/,
    (_f, a, n, c) => `${a}${Number(n) + 1}${c}`,
  );
  return out;
}
