import diffSequences from 'diff-sequences';
import { type SheetIR, type StringPool } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import type { CompareOptions } from '../options.js';
import type { TableModel } from '../table/index.js';
import { cellToken } from '../compare/normalize.js';
import { hashRow } from './hash.js';

export interface OrderRowMatch {
  /** `changed` is false for equal-hash pairs, true for similarity pairs. */
  pairs: { oldRow: number; newRow: number; changed: boolean; moved: boolean }[];
  removed: number[];
  added: number[];
  /** True when the order diff fell back to order-insensitive multiset pairing. */
  multiset: boolean;
}

const CHURN_RATIO = 0.4;
const WORK_BUDGET = 5e7;
const HUNK_LIMIT = 2000;
const SIMILARITY_MIN = 0.5;

interface MatchedCols {
  old: number[];
  new: number[];
}

function rowSimilarity(
  oldSheet: SheetIR,
  newSheet: SheetIR,
  oldPool: StringPool,
  newPool: StringPool,
  oldRow: number,
  newRow: number,
  cols: MatchedCols,
  opts: CompareOptions,
): number {
  if (cols.old.length === 0) return 0;
  let equal = 0;
  for (let i = 0; i < cols.old.length; i++) {
    const a = cellToken(getCell(oldSheet, oldPool, oldRow, cols.old[i]!), opts);
    const b = cellToken(getCell(newSheet, newPool, newRow, cols.new[i]!), opts);
    if (a === b) equal++;
  }
  return equal / cols.old.length;
}

/** Order-mode row matching (TDD §7.6). */
export function matchRowsByOrder(
  oldSheet: SheetIR,
  newSheet: SheetIR,
  oldTable: TableModel,
  newTable: TableModel,
  cols: MatchedCols,
  oldPool: StringPool,
  newPool: StringPool,
  opts: CompareOptions,
): OrderRowMatch {
  const oldRows: number[] = [];
  for (let r = oldTable.dataStart; r <= oldTable.dataEnd; r++) oldRows.push(r);
  const newRows: number[] = [];
  for (let r = newTable.dataStart; r <= newTable.dataEnd; r++) newRows.push(r);

  const oldHashes = oldRows.map((r) => hashRow(oldSheet, oldPool, r, cols.old, opts));
  const newHashes = newRows.map((r) => hashRow(newSheet, newPool, r, cols.new, opts));
  const N = oldRows.length;
  const M = newRows.length;

  if (N * M > WORK_BUDGET) {
    return multisetMatch(oldRows, newRows, oldHashes, newHashes);
  }

  // Myers diff over hash sequences → equal-hash anchor pairs.
  const equal: { a: number; b: number }[] = [];
  diffSequences(
    N,
    M,
    (i, j) => oldHashes[i] === newHashes[j],
    (nCommon, aStart, bStart) => {
      for (let k = 0; k < nCommon; k++) equal.push({ a: aStart + k, b: bStart + k });
    },
  );

  const D = N - equal.length + (M - equal.length);
  if (D > CHURN_RATIO * (N + M)) {
    return multisetMatch(oldRows, newRows, oldHashes, newHashes);
  }

  const pairs: OrderRowMatch['pairs'] = [];
  const removedIdx: number[] = [];
  const addedIdx: number[] = [];

  let prevA = 0;
  let prevB = 0;
  const flushGap = (aEnd: number, bEnd: number): void => {
    const delOld: number[] = [];
    const insNew: number[] = [];
    for (let i = prevA; i < aEnd; i++) delOld.push(i);
    for (let j = prevB; j < bEnd; j++) insNew.push(j);
    similarityPair(delOld, insNew, pairs, removedIdx, addedIdx);
  };

  for (const e of equal) {
    flushGap(e.a, e.b);
    pairs.push({ oldRow: oldRows[e.a]!, newRow: newRows[e.b]!, changed: false, moved: false });
    prevA = e.a + 1;
    prevB = e.b + 1;
  }
  flushGap(N, M);

  detectMoved(removedIdx, addedIdx, oldHashes, newHashes, oldRows, newRows, pairs);

  return {
    pairs,
    removed: removedIdx.map((i) => oldRows[i]!).sort((a, b) => a - b),
    added: addedIdx.map((j) => newRows[j]!).sort((a, b) => a - b),
    multiset: false,
  };

  function similarityPair(
    delOld: number[],
    insNew: number[],
    out: OrderRowMatch['pairs'],
    rem: number[],
    add: number[],
  ): void {
    // Split oversized hunks into windows to bound work.
    if (delOld.length > HUNK_LIMIT || insNew.length > HUNK_LIMIT) {
      const n = Math.max(delOld.length, insNew.length);
      for (let start = 0; start < n; start += HUNK_LIMIT) {
        similarityPair(
          delOld.slice(start, start + HUNK_LIMIT),
          insNew.slice(start, start + HUNK_LIMIT),
          out,
          rem,
          add,
        );
      }
      return;
    }
    const usedNew = new Set<number>();
    for (const oi of delOld) {
      let bestJ = -1;
      let bestScore = SIMILARITY_MIN;
      for (const nj of insNew) {
        if (usedNew.has(nj)) continue;
        const score = rowSimilarity(oldSheet, newSheet, oldPool, newPool, oldRows[oi]!, newRows[nj]!, cols, opts);
        if (score >= bestScore) {
          bestScore = score;
          bestJ = nj;
        }
      }
      if (bestJ >= 0) {
        usedNew.add(bestJ);
        out.push({ oldRow: oldRows[oi]!, newRow: newRows[bestJ]!, changed: true, moved: false });
      } else {
        rem.push(oi);
      }
    }
    for (const nj of insNew) if (!usedNew.has(nj)) add.push(nj);
  }
}

function detectMoved(
  removedIdx: number[],
  addedIdx: number[],
  oldHashes: bigint[],
  newHashes: bigint[],
  oldRows: number[],
  newRows: number[],
  pairs: OrderRowMatch['pairs'],
): void {
  const byHashNew = new Map<bigint, number[]>();
  for (const j of addedIdx) (byHashNew.get(newHashes[j]!) ?? byHashNew.set(newHashes[j]!, []).get(newHashes[j]!)!).push(j);
  const stillRemoved: number[] = [];
  const consumed = new Set<number>();
  for (const i of removedIdx) {
    const list = byHashNew.get(oldHashes[i]!);
    const j = list?.find((x) => !consumed.has(x));
    if (j !== undefined) {
      consumed.add(j);
      pairs.push({ oldRow: oldRows[i]!, newRow: newRows[j]!, changed: false, moved: true });
    } else {
      stillRemoved.push(i);
    }
  }
  removedIdx.length = 0;
  removedIdx.push(...stillRemoved);
  const stillAdded = addedIdx.filter((j) => !consumed.has(j));
  addedIdx.length = 0;
  addedIdx.push(...stillAdded);
}

function multisetMatch(
  oldRows: number[],
  newRows: number[],
  oldHashes: bigint[],
  newHashes: bigint[],
): OrderRowMatch {
  const byHashNew = new Map<bigint, number[]>();
  newRows.forEach((_, j) => {
    (byHashNew.get(newHashes[j]!) ?? byHashNew.set(newHashes[j]!, []).get(newHashes[j]!)!).push(j);
  });
  const cursor = new Map<bigint, number>();
  const pairs: OrderRowMatch['pairs'] = [];
  const removed: number[] = [];
  const consumed = new Set<number>();
  oldRows.forEach((r, i) => {
    const h = oldHashes[i]!;
    const list = byHashNew.get(h);
    const idx = cursor.get(h) ?? 0;
    if (list && idx < list.length) {
      const j = list[idx]!;
      cursor.set(h, idx + 1);
      consumed.add(j);
      pairs.push({ oldRow: r, newRow: newRows[j]!, changed: false, moved: false });
    } else {
      removed.push(r);
    }
  });
  const added = newRows.filter((_, j) => !consumed.has(j));
  return { pairs, removed, added, multiset: true };
}
