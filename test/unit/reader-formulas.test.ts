import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { readWorkbook, getCell } from '../../src/index.js';
import { hasFormulaOnlyCells } from '../../src/read/formula-scan.js';

/** A minimal .xlsx whose single sheet "S" has exactly the given <sheetData> rows. */
function rawXlsx(sheetData: string): Uint8Array {
  const xml = (s: string): Uint8Array => strToU8(`<?xml version="1.0" encoding="UTF-8"?>${s}`);
  return zipSync({
    '[Content_Types].xml': xml(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    '_rels/.rels': xml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': xml(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': xml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/worksheets/sheet1.xml': xml(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`,
    ),
  });
}

const str = (r: string, text: string): string => `<c r="${r}" t="inlineStr"><is><t>${text}</t></is></c>`;

describe('formula cells saved without a cached value', () => {
  // Row 1: header + the shapes real writers produce. Row 2-3: a shared formula.
  const sheet =
    `<row r="1">${str('A1', 'key')}` +
    `<c r="B1"><f>1+1</f></c>` + //                          no <v> at all (SheetLens merge output)
    `<c r="C1"><f>1+2</f><v></v></c>` + //                   empty <v></v> (openpyxl)
    `<c r="D1"><f>1+3</f><v>4</v></c>` + //                  Excel: formula and cached value
    `<c r="E1"><v>7</v></c>` + //                            plain value
    `<c r="F1" s="1"/>` + //                                 styled but blank
    `<c r="G1" t="str"><f>A1&amp;"x"</f></c>` + //           string result, t present
    `</row><row r="2"><c r="B2"><f t="shared" ref="B2:B3" si="0">B1*2</f></c></row>` +
    `<row r="3"><c r="B3"><f t="shared" si="0"/></c></row>`;

  it('keeps the formula (and no value) for each of them', async () => {
    const wb = await readWorkbook(rawXlsx(sheet), { fileName: 'x.xlsx' });
    const s = wb.sheets[0]!;
    const at = (r: number, c: number) => getCell(s, wb.pool, r, c);

    expect(at(0, 1).formula).toBe('1+1');
    expect(at(0, 2).formula).toBe('1+2');
    expect(at(0, 3)).toMatchObject({ formula: '1+3', num: 4 }); //    unchanged: value and formula
    expect(at(0, 4)).toMatchObject({ num: 7 });
    expect(at(0, 4).formula).toBeUndefined();
    expect(at(0, 6).formula).toBe('A1&"x"');
    // The shared formula is expanded for the dependent cell, as Excel would.
    expect(at(1, 1).formula).toBe('B1*2');
    expect(at(2, 1).formula).toBe('B2*2');
  });

  it('a styled-but-blank cell stays blank (stubs must not invent content)', async () => {
    const wb = await readWorkbook(rawXlsx(sheet), { fileName: 'x.xlsx' });
    const f1 = getCell(wb.sheets[0]!, wb.pool, 0, 5);
    expect(f1.formula).toBeUndefined();
    expect(f1.text).toBe('');
    expect(Number.isNaN(f1.num)).toBe(true);
  });

  it('valuesOnly still reads no formulas', async () => {
    const wb = await readWorkbook(rawXlsx(sheet), { fileName: 'x.xlsx', valuesOnly: true });
    expect(getCell(wb.sheets[0]!, wb.pool, 0, 1).formula).toBeUndefined();
  });
});

describe('hasFormulaOnlyCells — only pay for stubs when a file needs them', () => {
  const sheetWith = (cells: string): Uint8Array => rawXlsx(`<row r="1">${cells}</row>`);

  it.each([
    ['a formula with no <v>', '<c r="A1"><f>1+1</f></c>'],
    ['a formula with an empty <v></v>', '<c r="A1"><f>1+1</f><v></v></c>'],
    ['a formula with a self-closing <v/>', '<c r="A1"><f>1+1</f><v/></c>'],
    ['a shared-formula child', '<c r="A1"><f t="shared" si="0"/></c>'],
    ['whitespace between the elements', '<c r="A1" s="3">\n  <f ca="1">NOW()</f>\n</c>'],
  ])('finds %s', (_n, cells) => {
    expect(hasFormulaOnlyCells(sheetWith(cells))).toBe(true);
  });

  it.each([
    ['an Excel-style formula with its cached value', '<c r="A1"><f>1+1</f><v>2</v></c>'],
    ['a formula returning "" (Excel writes t="str" and an empty <v>)', '<c r="A1" t="str"><f>""</f><v></v></c>'],
    ['a formula with a string result', '<c r="A1" t="str"><f>"a"</f><v>a</v></c>'],
    ['plain values and blanks', '<c r="A1"><v>1</v></c><c r="B1" s="1"/>'],
    ['no cells at all', ''],
  ])('does not flag %s', (_n, cells) => {
    expect(hasFormulaOnlyCells(sheetWith(cells))).toBe(false);
  });

  it('finds one that straddles the 8 MB scan-window boundary', () => {
    const WINDOW = 8 * 1024 * 1024;
    const head = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">';
    const cell = '<c r="A1"><f>1+1</f></c>';
    // Pad so the formula-only cell starts 10 bytes before the boundary and ends after it.
    const padding = ' '.repeat(WINDOW - 10 - head.length);
    const xml = `${head}${padding}${cell}</row></sheetData></worksheet>`;
    const start = xml.indexOf(cell);
    expect(start).toBeLessThan(WINDOW);
    expect(start + cell.length).toBeGreaterThan(WINDOW);

    const bytes = zipSync({ 'xl/worksheets/sheet1.xml': strToU8(xml) });
    expect(hasFormulaOnlyCells(bytes)).toBe(true);
  });

  it('does not flag the shipped Excel fixtures (so they never pay for stubs)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of [
      'compare/Sales_Register_Sep2026_v1.xlsx',
      'compare/Sales_Register_Sep2026_FINAL.xlsx',
      'merge/Sales_Register_Sep2026_ORIGINAL.xlsx',
      'merge/Sales_Register_Sep2026_RAVI.xlsx',
      'merge/Sales_Register_Sep2026_PRIYA.xlsx',
    ]) {
      const p = resolve(here, '../../docs/fixtures', f);
      if (existsSync(p)) expect(hasFormulaOnlyCells(new Uint8Array(readFileSync(p))), f).toBe(false);
    }
  });
});
