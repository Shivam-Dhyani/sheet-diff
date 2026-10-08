import type { SheetIR, StringPool } from '../ir/types.js';
import type { CompareOptions } from '../options.js';
import type { TableModel } from '../table/index.js';
import { keyForRow } from './keys.js';

export interface RowMatch {
  /** Matched row pairs (absolute 0-based sheet rows). */
  pairs: { oldRow: number; newRow: number }[];
  removed: number[];
  added: number[];
}

/**
 * Key-mode row matching: pair occurrences of equal keys in order of appearance
 * (BR-C2). O(n). Rows with no resolvable key are treated as removed/added.
 */
export function matchRowsByKey(
  oldSheet: SheetIR,
  newSheet: SheetIR,
  oldTable: TableModel,
  newTable: TableModel,
  oldKeyCols: number[],
  newKeyCols: number[],
  oldPool: StringPool,
  newPool: StringPool,
  opts: CompareOptions,
): RowMatch {
  const newByKey = new Map<string, number[]>();
  const newNullRows: number[] = [];
  for (let r = newTable.dataStart; r <= newTable.dataEnd; r++) {
    const key = keyForRow(newSheet, newPool, newKeyCols, r, opts);
    if (key === null) {
      newNullRows.push(r);
      continue;
    }
    (newByKey.get(key) ?? newByKey.set(key, []).get(key)!).push(r);
  }

  const cursor = new Map<string, number>();
  const pairs: { oldRow: number; newRow: number }[] = [];
  const removed: number[] = [];
  const consumedNew = new Set<number>();

  for (let r = oldTable.dataStart; r <= oldTable.dataEnd; r++) {
    const key = keyForRow(oldSheet, oldPool, oldKeyCols, r, opts);
    if (key === null) {
      removed.push(r);
      continue;
    }
    const list = newByKey.get(key);
    if (!list) {
      removed.push(r);
      continue;
    }
    const idx = cursor.get(key) ?? 0;
    if (idx < list.length) {
      const newRow = list[idx]!;
      cursor.set(key, idx + 1);
      consumedNew.add(newRow);
      pairs.push({ oldRow: r, newRow });
    } else {
      removed.push(r);
    }
  }

  const added: number[] = [];
  for (const list of newByKey.values()) {
    for (const r of list) if (!consumedNew.has(r)) added.push(r);
  }
  added.push(...newNullRows);
  added.sort((a, b) => a - b);

  return { pairs, removed, added };
}
