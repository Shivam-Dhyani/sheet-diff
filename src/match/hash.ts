import type { SheetIR, StringPool } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import type { CompareOptions } from '../options.js';
import { cellToken } from '../compare/normalize.js';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;
const SEP = 0x1fn; // unit separator byte between cells

/** 64-bit FNV-1a over a string's UTF-16 code units. */
export function fnv1a64(s: string, seed: bigint = FNV_OFFSET): bigint {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i) & 0xff);
    h = (h * FNV_PRIME) & MASK64;
    h ^= BigInt((s.charCodeAt(i) >> 8) & 0xff);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/**
 * Hash a row over the given (0-based) columns using normalized tokens, with a
 * separator between cells (TDD §7.6). Deterministic for equal values per options.
 */
export function hashRow(
  sheet: SheetIR,
  pool: StringPool,
  r: number,
  cols: number[],
  opts: CompareOptions,
): bigint {
  let h = FNV_OFFSET;
  for (const c of cols) {
    const token = cellToken(getCell(sheet, pool, r, c), opts);
    h = fnv1a64(token, h);
    h ^= SEP;
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}
