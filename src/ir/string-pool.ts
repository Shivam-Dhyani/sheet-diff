import type { StringPool } from './types.js';

/**
 * Simple interning pool backed by a Map. Id 0 is the "no string" sentinel and
 * is never handed out by {@link intern}. Interned strings are NFC-normalized
 * lazily by callers where comparison matters; the pool stores them verbatim.
 */
export class MapStringPool implements StringPool {
  private readonly ids = new Map<string, number>();
  private readonly values: string[] = [''];

  intern(s: string): number {
    if (s === '') return 0;
    const existing = this.ids.get(s);
    if (existing !== undefined) return existing;
    const id = this.values.length;
    this.values.push(s);
    this.ids.set(s, id);
    return id;
  }

  get(id: number): string {
    return this.values[id] ?? '';
  }

  get size(): number {
    return this.values.length - 1;
  }
}

export function createStringPool(): StringPool {
  return new MapStringPool();
}
