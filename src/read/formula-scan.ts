import { unzipSync } from 'fflate';

/**
 * Does any worksheet hold a formula cell with no cached value?
 *
 * Excel always saves the last computed value next to a formula (`<f>…</f><v>…</v>`).
 * Writers that leave recalculation to Excel — openpyxl, many exporters, and the files
 * SheetLens itself writes for a merge — save the formula alone. SheetJS drops such a
 * cell entirely unless `sheetStubs` is on, so the formula would silently vanish.
 *
 * `sheetStubs` makes SheetJS materialise every styled-but-blank cell too, which roughly
 * doubles read time and triples memory on a sheet with a lot of formatting. So it is
 * turned on only for files where this scan finds a formula-only cell.
 *
 * SheetJS keeps a cell whose `t` attribute is set even with no value (e.g. a formula that
 * returns an empty string is written `t="str"`), so those are not formula-only here.
 */
const FORMULA_ONLY =
  // <c …no t=…> <f …>text</f> | <f …/>   then nothing, or an empty <v/>, then </c>
  /<c\b(?![^>]*\st=)[^>]*>\s*<f\b(?:[^>]*\/>|[^>]*>[^<]*<\/f>)\s*(?:<v\s*\/>|<v[^>]*><\/v>)?\s*<\/c>/;

const WINDOW = 8 * 1024 * 1024;
/** Longer than any single cell, so a match split across two windows is whole in the next. */
const OVERLAP = 32 * 1024;

const latin1 = new TextDecoder('latin1');

/** Scan one worksheet's bytes in windows, so a huge sheet never becomes one huge string. */
function sheetHasFormulaOnlyCell(xml: Uint8Array): boolean {
  for (let start = 0; start < xml.length; start += WINDOW) {
    const end = Math.min(xml.length, start + WINDOW + OVERLAP);
    if (FORMULA_ONLY.test(latin1.decode(xml.subarray(start, end)))) return true;
  }
  return false;
}

export function hasFormulaOnlyCells(zipBytes: Uint8Array): boolean {
  // List the entries without inflating anything, then inflate one worksheet at a time.
  const sheets: string[] = [];
  unzipSync(zipBytes, {
    filter: (f) => {
      if (/^xl\/worksheets\/[^/]+\.xml$/i.test(f.name)) sheets.push(f.name);
      return false;
    },
  });
  for (const name of sheets) {
    const parts = unzipSync(zipBytes, { filter: (f) => f.name === name });
    const xml = parts[name];
    if (xml && sheetHasFormulaOnlyCell(xml)) return true;
  }
  return false;
}
