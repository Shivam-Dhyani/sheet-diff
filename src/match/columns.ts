import { CellKind, type SheetIR, type StringPool } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import type { ColumnMatch } from '../types.js';
import type { TableModel, DetectedColumn } from '../table/index.js';
import { jaroWinkler, tokenSetRatio } from './similarity.js';

const COLUMN_MATCH_THRESHOLD = 0.85;

/** Normalize a header for matching (TDD §7.4). */
export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\(\s*rs\.?\s*\)|\(\s*inr\s*\)|\(\s*₹\s*\)|₹/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ColumnMatchResult {
  matches: ColumnMatch[];
  /** old col index → new col index (for formula translation). */
  oldToNew: Map<number, number>;
  newToOld: Map<number, number>;
  /** Columns present in both sides, keyed by header for key detection. */
  common: { header: string; oldIndex: number; newIndex: number }[];
}

/** Dominant cell kind of a column over its data range. */
function dominantKind(sheet: SheetIR, pool: StringPool, col: number, table: TableModel): CellKind {
  const counts = new Map<CellKind, number>();
  for (let r = table.dataStart; r <= table.dataEnd; r++) {
    const k = getCell(sheet, pool, r, col).kind;
    if (k === CellKind.Empty) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best: CellKind = CellKind.Empty;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
}

export function matchColumns(
  oldSheet: SheetIR,
  newSheet: SheetIR,
  oldTable: TableModel,
  newTable: TableModel,
  oldPool: StringPool,
  newPool: StringPool,
): ColumnMatchResult {
  const oldCols = oldTable.columns;
  const newCols = newTable.columns;
  const oldToNew = new Map<number, number>();
  const newToOld = new Map<number, number>();
  const matches: ColumnMatch[] = [];
  const common: { header: string; oldIndex: number; newIndex: number }[] = [];

  const newUsed = new Set<number>(); // indices into newCols
  const oldMatched = new Set<number>();

  // Pass 1: exact normalized header match (disambiguate duplicates by order).
  const newByNorm = new Map<string, number[]>();
  newCols.forEach((col, i) => {
    const key = normalizeHeader(col.header);
    (newByNorm.get(key) ?? newByNorm.set(key, []).get(key)!).push(i);
  });

  oldCols.forEach((oc, oi) => {
    const key = normalizeHeader(oc.header);
    const candidates = newByNorm.get(key);
    if (candidates) {
      const ni = candidates.find((i) => !newUsed.has(i));
      if (ni !== undefined) {
        newUsed.add(ni);
        oldMatched.add(oi);
        link(oc, newCols[ni]!, 'matched');
      }
    }
  });

  // Pass 2: fuzzy match remaining columns (score ≥ threshold → renamed).
  for (let oi = 0; oi < oldCols.length; oi++) {
    if (oldMatched.has(oi)) continue;
    const oc = oldCols[oi]!;
    const on = normalizeHeader(oc.header);
    const oKind = dominantKind(oldSheet, oldPool, oc.index, oldTable);
    let bestI = -1;
    let bestScore = 0;
    for (let ni = 0; ni < newCols.length; ni++) {
      if (newUsed.has(ni)) continue;
      const nc = newCols[ni]!;
      const nn = normalizeHeader(nc.header);
      const nKind = dominantKind(newSheet, newPool, nc.index, newTable);
      const typeAgreement = oKind === nKind ? 1 : 0.7;
      const score = Math.max(jaroWinkler(on, nn), tokenSetRatio(on, nn)) * typeAgreement;
      if (score > bestScore) {
        bestScore = score;
        bestI = ni;
      }
    }
    if (bestI >= 0 && bestScore >= COLUMN_MATCH_THRESHOLD) {
      newUsed.add(bestI);
      oldMatched.add(oi);
      link(oc, newCols[bestI]!, 'renamed');
    }
  }

  // Remaining unmatched → removed / added.
  oldCols.forEach((oc, oi) => {
    if (!oldMatched.has(oi)) {
      matches.push({ oldName: oc.header, oldIndex: oc.index, status: 'removed' });
    }
  });
  newCols.forEach((nc, ni) => {
    if (!newUsed.has(ni)) {
      matches.push({ newName: nc.header, newIndex: nc.index, status: 'added' });
    }
  });

  return { matches, oldToNew, newToOld, common };

  function link(oc: DetectedColumn, nc: DetectedColumn, status: 'matched' | 'renamed'): void {
    oldToNew.set(oc.index, nc.index);
    newToOld.set(nc.index, oc.index);
    matches.push({
      oldName: oc.header,
      newName: nc.header,
      oldIndex: oc.index,
      newIndex: nc.index,
      status,
    });
    common.push({ header: nc.header, oldIndex: oc.index, newIndex: nc.index });
  }
}
