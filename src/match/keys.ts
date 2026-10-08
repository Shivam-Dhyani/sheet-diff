import { CellKind, type SheetIR, type StringPool } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import type { KeyInfo } from '../types.js';
import type { CompareOptions } from '../options.js';
import type { TableModel } from '../table/index.js';
import { cellToken, parseNumericText } from '../compare/normalize.js';
import { parseTextDate } from '../compare/dates.js';

const KEY_NAME_RE = /\b(no\.?|number|id|code|ref|invoice|inv|bill|voucher|vch|employee|emp|gstin|pan|sku|order)\b/i;
const KEY_SEP = '\u001f';

export interface CommonColumn {
  header: string;
  oldIndex: number;
  newIndex: number;
}

export interface KeyResult {
  info: KeyInfo;
  oldCols: number[];
  newCols: number[];
}

interface ColStats {
  fill: number;
  uniq: number;
  distinctRatio: number;
  isDate: boolean;
  isDecimal: boolean;
}

function columnStats(
  sheet: SheetIR,
  pool: StringPool,
  col: number,
  table: TableModel,
  opts: CompareOptions,
): ColStats {
  const rows = Math.max(0, table.dataEnd - table.dataStart + 1);
  let nonEmpty = 0;
  let dateLike = 0;
  let numeric = 0;
  let decimal = 0;
  const distinct = new Set<string>();
  for (let r = table.dataStart; r <= table.dataEnd; r++) {
    const cell = getCell(sheet, pool, r, col);
    if (cell.kind === CellKind.Empty && !cell.formula) continue;
    nonEmpty++;
    distinct.add(cellToken(cell, opts));
    if (cell.kind === CellKind.DateSerial) dateLike++;
    else if (cell.kind === CellKind.String && parseTextDate(cell.text, opts.dateOrder)) dateLike++;
    const num =
      cell.kind === CellKind.Number
        ? cell.num
        : cell.kind === CellKind.String
          ? parseNumericText(cell.text)
          : null;
    if (num !== null) {
      numeric++;
      if (!Number.isInteger(num)) decimal++;
    }
  }
  const fill = rows > 0 ? nonEmpty / rows : 0;
  const uniq = nonEmpty > 0 ? distinct.size / nonEmpty : 0;
  const distinctRatio = rows > 0 ? distinct.size / rows : 0;
  return {
    fill,
    uniq,
    distinctRatio,
    isDate: nonEmpty > 0 && dateLike / nonEmpty >= 0.5,
    isDecimal: numeric > 0 && decimal / numeric >= 0.3,
  };
}

/** Count duplicate key values on a side (sum of extra occurrences). */
function countDuplicates(
  sheet: SheetIR,
  pool: StringPool,
  cols: number[],
  table: TableModel,
  opts: CompareOptions,
): number {
  const seen = new Map<string, number>();
  for (let r = table.dataStart; r <= table.dataEnd; r++) {
    const key = keyForRow(sheet, pool, cols, r, opts);
    if (key === null) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let dup = 0;
  for (const n of seen.values()) if (n > 1) dup += n - 1;
  return dup;
}

/** Build the (normalized) key string for a row, or null if any key cell is empty. */
export function keyForRow(
  sheet: SheetIR,
  pool: StringPool,
  cols: number[],
  r: number,
  opts: CompareOptions,
): string | null {
  const parts: string[] = [];
  for (const c of cols) {
    const cell = getCell(sheet, pool, r, c);
    if (cell.kind === CellKind.Empty && !cell.formula) return null;
    parts.push(cellToken(cell, opts));
  }
  return parts.join(KEY_SEP);
}

export function detectKey(
  oldSheet: SheetIR,
  newSheet: SheetIR,
  oldTable: TableModel,
  newTable: TableModel,
  common: CommonColumn[],
  oldPool: StringPool,
  newPool: StringPool,
  opts: CompareOptions,
  provided?: string[],
): KeyResult {
  // Explicit override from Setup.
  if (provided && provided.length > 0) {
    const chosen = common.filter((c) => provided.includes(c.header));
    if (chosen.length > 0) {
      const oldCols = chosen.map((c) => c.oldIndex);
      const newCols = chosen.map((c) => c.newIndex);
      return {
        info: {
          columns: chosen.map((c) => c.header),
          mode: chosen.length === 1 ? 'key' : 'composite',
          confidence: 'high',
          duplicates: countDuplicates(newSheet, newPool, newCols, newTable, opts),
        },
        oldCols,
        newCols,
      };
    }
  }

  // Single-column scoring.
  let best: { col: CommonColumn; score: number; high: boolean } | null = null;
  const statCache = new Map<number, { o: ColStats; n: ColStats }>();
  for (const c of common) {
    const o = columnStats(oldSheet, oldPool, c.oldIndex, oldTable, opts);
    const n = columnStats(newSheet, newPool, c.newIndex, newTable, opts);
    statCache.set(c.oldIndex, { o, n });
    const nameBonus = KEY_NAME_RE.test(c.header) ? 1 : 0;
    const score =
      Math.min(o.fill, n.fill) * Math.min(o.uniq, n.uniq) +
      0.05 * nameBonus -
      0.3 * (o.isDate || n.isDate ? 1 : 0) -
      0.3 * (o.isDecimal || n.isDecimal ? 1 : 0);
    const qualifies = o.fill >= 0.98 && n.fill >= 0.98 && o.uniq >= 0.98 && n.uniq >= 0.98;
    if (qualifies && (!best || score > best.score)) {
      best = { col: c, score, high: o.uniq >= 1 && n.uniq >= 1 };
    }
  }

  if (best) {
    return {
      info: {
        columns: [best.col.header],
        mode: 'key',
        confidence: best.high ? 'high' : 'medium',
        duplicates: countDuplicates(newSheet, newPool, [best.col.newIndex], newTable, opts),
      },
      oldCols: [best.col.oldIndex],
      newCols: [best.col.newIndex],
    };
  }

  // Composite: top 8 columns by distinct ratio, try pairs then triples.
  const ranked = [...common]
    .map((c) => ({ c, dr: Math.min(statCache.get(c.oldIndex)?.o.distinctRatio ?? 0, statCache.get(c.oldIndex)?.n.distinctRatio ?? 0) }))
    .sort((a, b) => b.dr - a.dr)
    .slice(0, 8)
    .map((x) => x.c);

  const composite = findComposite(oldSheet, newSheet, oldTable, newTable, ranked, oldPool, newPool, opts);
  if (composite) {
    return {
      info: {
        columns: composite.map((c) => c.header),
        mode: 'composite',
        confidence: 'medium',
        duplicates: countDuplicates(
          newSheet,
          newPool,
          composite.map((c) => c.newIndex),
          newTable,
          opts,
        ),
      },
      oldCols: composite.map((c) => c.oldIndex),
      newCols: composite.map((c) => c.newIndex),
    };
  }

  // No key → order mode.
  return { info: { columns: [], mode: 'order', confidence: 'low', duplicates: 0 }, oldCols: [], newCols: [] };
}

function uniqueness(
  sheet: SheetIR,
  pool: StringPool,
  cols: number[],
  table: TableModel,
  opts: CompareOptions,
): number {
  const rows = Math.max(0, table.dataEnd - table.dataStart + 1);
  if (rows === 0) return 0;
  const distinct = new Set<string>();
  let nonEmpty = 0;
  for (let r = table.dataStart; r <= table.dataEnd; r++) {
    const key = keyForRow(sheet, pool, cols, r, opts);
    if (key === null) continue;
    nonEmpty++;
    distinct.add(key);
  }
  return nonEmpty > 0 ? distinct.size / nonEmpty : 0;
}

function findComposite(
  oldSheet: SheetIR,
  newSheet: SheetIR,
  oldTable: TableModel,
  newTable: TableModel,
  cols: CommonColumn[],
  oldPool: StringPool,
  newPool: StringPool,
  opts: CompareOptions,
): CommonColumn[] | null {
  const nameBonus = (combo: CommonColumn[]): number =>
    combo.reduce((s, c) => s + (KEY_NAME_RE.test(c.header) ? 1 : 0), 0);
  const candidates: CommonColumn[][] = [];
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      candidates.push([cols[i]!, cols[j]!]);
    }
  }
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      for (let k = j + 1; k < cols.length; k++) {
        candidates.push([cols[i]!, cols[j]!, cols[k]!]);
      }
    }
  }
  // Prefer fewer columns, then higher nameBonus.
  candidates.sort((a, b) => a.length - b.length || nameBonus(b) - nameBonus(a));
  for (const combo of candidates) {
    const oldCols = combo.map((c) => c.oldIndex);
    const newCols = combo.map((c) => c.newIndex);
    if (
      uniqueness(oldSheet, oldPool, oldCols, oldTable, opts) >= 0.99 &&
      uniqueness(newSheet, newPool, newCols, newTable, opts) >= 0.99
    ) {
      return combo;
    }
  }
  return null;
}
