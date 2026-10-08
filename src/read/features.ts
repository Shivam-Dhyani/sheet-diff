import { unzipSync } from 'fflate';
import type { FeatureInventory } from '../ir/types.js';
import { emptyFeatureInventory } from '../ir/types.js';

/**
 * Build the feature inventory from an OOXML zip (TDD §6.2) with light XML
 * scans. Row-level anchor details (drawing rows, array-formula rows, extLst
 * sqref) are populated in the merge increment where the blockers (§10.5)
 * consume them; the cheap, sheet-level associations are filled here.
 */
export function readFeatures(bytes: Uint8Array): FeatureInventory {
  const inv = emptyFeatureInventory();
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes, {
      filter: (f) =>
        f.name === '[Content_Types].xml' ||
        f.name === 'xl/workbook.xml' ||
        f.name === 'xl/_rels/workbook.xml.rels' ||
        f.name.startsWith('xl/tables/') ||
        f.name.startsWith('xl/charts/') ||
        f.name.startsWith('xl/pivotCache/') ||
        f.name.startsWith('xl/externalLinks/') ||
        f.name.startsWith('xl/worksheets/_rels/'),
    });
  } catch {
    return inv;
  }

  const td = new TextDecoder('utf-8');
  const text = (name: string): string => {
    const b = parts[name];
    return b ? td.decode(b) : '';
  };

  const names = Object.keys(parts);

  // Macros
  const ct = text('[Content_Types].xml');
  inv.hasMacros = ct.includes('ms-office.vbaProject') || names.some((n) => n.includes('vbaProject'));

  // Map sheet name → worksheet part path via workbook.xml + rels.
  const sheetPathByName = mapSheetPaths(text('xl/workbook.xml'), text('xl/_rels/workbook.xml.rels'));

  // External links
  inv.externalLinks = names.filter((n) =>
    /^xl\/externalLinks\/externalLink\d+\.xml$/.test(n),
  ).length;

  // Charts → sheet names referenced in series formulas (<c:f>Sheet!...)
  const chartSheets = new Set<string>();
  for (const n of names) {
    if (!/^xl\/charts\/chart\d+\.xml$/.test(n)) continue;
    for (const m of text(n).matchAll(/<c:f>([^<]*)<\/c:f>/g)) {
      const sheet = sheetFromRef(m[1] ?? '');
      if (sheet) chartSheets.add(sheet);
    }
  }
  inv.charts = [...chartSheets];

  // Pivot cache worksheet sources
  const pivotSheets = new Set<string>();
  for (const n of names) {
    if (!/^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/.test(n)) continue;
    for (const m of text(n).matchAll(/worksheetSource[^>]*\bsheet="([^"]+)"/g)) {
      if (m[1]) pivotSheets.add(decodeXml(m[1]));
    }
  }
  inv.pivotSources = [...pivotSheets];

  // Tables → {name, ref}; associate to a sheet through worksheet rels.
  const tablePartToSheet = mapTablePartsToSheets(parts, sheetPathByName, td);
  for (const n of names) {
    if (!/^xl\/tables\/table\d+\.xml$/.test(n)) continue;
    const t = text(n);
    const name = /\bname="([^"]+)"/.exec(t)?.[1];
    const ref = /\bref="([^"]+)"/.exec(t)?.[1];
    const sheet = tablePartToSheet.get(n);
    if (sheet && name && ref) {
      (inv.tablesBySheet[sheet] ??= []).push({ name: decodeXml(name), ref });
    }
  }

  // Comments presence per sheet (rows filled in merge increment).
  for (const [sheetName, path] of Object.entries(sheetPathByName)) {
    const relsPath = `xl/worksheets/_rels/${path.replace(/^xl\/worksheets\//, '')}.rels`;
    const rels = text(relsPath);
    if (/comments\d*\.xml/.test(rels) || /vmlDrawing\d*\.vml/.test(rels)) {
      inv.commentsBySheet[sheetName] = [];
    }
    if (/drawing\d*\.xml/.test(rels)) {
      inv.drawingsAnchorRows[sheetName] = [];
    }
  }

  return inv;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Extract the sheet name from a reference like `Sheet1!$A$1` or `'My Sheet'!A1`. */
function sheetFromRef(ref: string): string | null {
  const m = /^(?:'((?:[^']|'')+)'|([^'!]+))!/.exec(ref.trim());
  if (!m) return null;
  return m[1] !== undefined ? m[1].replace(/''/g, "'") : (m[2] ?? null);
}

/** sheet name → worksheet part path, via workbook.xml r:id → rels target. */
function mapSheetPaths(workbookXml: string, relsXml: string): Record<string, string> {
  const ridToTarget = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0];
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (id && target) ridToTarget.set(id, normalizeXlPath(target));
  }
  const out: Record<string, string> = {};
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = m[0];
    const name = /\bname="([^"]+)"/.exec(tag)?.[1];
    const rid = /\br:id="([^"]+)"/.exec(tag)?.[1] ?? /\br:id='([^']+)'/.exec(tag)?.[1];
    if (name && rid && ridToTarget.has(rid)) {
      out[decodeXml(name)] = ridToTarget.get(rid)!;
    }
  }
  return out;
}

function normalizeXlPath(target: string): string {
  // Targets in workbook.xml.rels are relative to xl/.
  const t = target.replace(/^\//, '');
  return t.startsWith('xl/') ? t : `xl/${t}`;
}

/** table part path → sheet name, via each worksheet's rels. */
function mapTablePartsToSheets(
  parts: Record<string, Uint8Array>,
  sheetPathByName: Record<string, string>,
  td: InstanceType<typeof TextDecoder>,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [sheetName, wsPath] of Object.entries(sheetPathByName)) {
    const base = wsPath.replace(/^xl\/worksheets\//, '');
    const relsPath = `xl/worksheets/_rels/${base}.rels`;
    const relsBytes = parts[relsPath];
    if (!relsBytes) continue;
    const rels = td.decode(relsBytes);
    for (const m of rels.matchAll(/Target="([^"]*tables\/table\d+\.xml)"/g)) {
      const tgt = m[1]!.replace(/^\.\.\//, 'xl/').replace(/^\//, '');
      const full = tgt.startsWith('xl/') ? tgt : `xl/${tgt}`;
      result.set(full, sheetName);
    }
  }
  return result;
}
