import type { Parts } from './zip.js';
import { readText, writeText } from './zip.js';

/**
 * Force a full recalculation on open and drop the stale calc chain (TDD §10.7).
 * Excel/LibreOffice then recompute every formula, so the merged totals are
 * correct regardless of the cached `<v>` values we left behind.
 */
export function setFullCalcOnLoad(parts: Parts): void {
  let workbook = readText(parts, 'xl/workbook.xml');
  if (!workbook) return;

  if (/<calcPr\b[^>]*\/>/.test(workbook)) {
    workbook = workbook.replace(/<calcPr\b([^>]*)\/>/, (full, attrs: string) => {
      if (/\bfullCalcOnLoad=/.test(attrs)) {
        return `<calcPr${attrs.replace(/\bfullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"')}/>`;
      }
      return `<calcPr${attrs} fullCalcOnLoad="1"/>`;
    });
  } else if (/<calcPr\b[^>]*>[\s\S]*?<\/calcPr>/.test(workbook)) {
    workbook = workbook.replace(/<calcPr\b([^>]*)>/, (_f, attrs: string) =>
      /\bfullCalcOnLoad=/.test(attrs)
        ? `<calcPr${attrs.replace(/\bfullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"')}>`
        : `<calcPr${attrs} fullCalcOnLoad="1">`,
    );
  } else {
    // Insert a calcPr before </workbook> or after </sheets>.
    if (/<\/sheets>/.test(workbook)) {
      workbook = workbook.replace(/<\/sheets>/, `</sheets><calcPr calcId="0" fullCalcOnLoad="1"/>`);
    } else {
      workbook = workbook.replace(/<\/workbook>/, `<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>`);
    }
  }
  writeText(parts, 'xl/workbook.xml', workbook);

  // Remove calcChain + its relationship + content-type override (Excel rebuilds it).
  if (parts['xl/calcChain.xml']) {
    delete parts['xl/calcChain.xml'];
    const relsPath = 'xl/_rels/workbook.xml.rels';
    const rels = readText(parts, relsPath);
    if (rels) {
      writeText(
        parts,
        relsPath,
        rels.replace(/<Relationship\b[^>]*calcChain\.xml"[^>]*\/>/g, ''),
      );
    }
    const ct = readText(parts, '[Content_Types].xml');
    if (ct) {
      writeText(
        parts,
        '[Content_Types].xml',
        ct.replace(/<Override\b[^>]*\/xl\/calcChain\.xml"[^>]*\/>/g, ''),
      );
    }
  }
}
