import { describe, it, expect } from 'vitest';
import { contrastCells, primaryPair } from '../../src/compare/contrast.js';
import type { CompareResult } from '../../src/index.js';

type PairStub = { id: string; status: string; mode: 'key' | 'composite' | 'order' };

/** A minimal result: only the fields the contrast rule reads. */
function result(pairs: PairStub[], baseline: Record<string, number>): CompareResult {
  return {
    pairs: pairs.map((p) => ({ id: p.id, status: p.status, key: { mode: p.mode, columns: [] } })),
    positionalBaseline: baseline,
  } as unknown as CompareResult;
}

describe('primaryPair / contrastCells (FR-RES-01)', () => {
  it('uses the primary data sheet, not the sum across sheets', () => {
    const r = result(
      [
        { id: 'Sales', status: 'matched', mode: 'key' },
        { id: 'Summary', status: 'matched', mode: 'order' },
      ],
      { Sales: 89, Summary: 3 },
    );
    expect(primaryPair(r)?.id).toBe('Sales');
    expect(contrastCells(r)).toBe(89); // not 92
  });

  it('prefers a keyed sheet over an earlier order-matched one', () => {
    const r = result(
      [
        { id: 'Notes', status: 'matched', mode: 'order' },
        { id: 'Sales', status: 'renamed', mode: 'composite' },
      ],
      { Notes: 5, Sales: 40 },
    );
    expect(primaryPair(r)?.id).toBe('Sales');
    expect(contrastCells(r)).toBe(40);
  });

  it('never picks an added or removed sheet', () => {
    const r = result(
      [
        { id: 'Credit Notes', status: 'added', mode: 'key' },
        { id: 'Old', status: 'removed', mode: 'key' },
        { id: 'Sales', status: 'matched', mode: 'order' },
      ],
      { Sales: 12 },
    );
    expect(primaryPair(r)?.id).toBe('Sales');
    expect(contrastCells(r)).toBe(12);
  });

  it('falls back to the first compared sheet when none has a key', () => {
    const r = result(
      [
        { id: 'A', status: 'matched', mode: 'order' },
        { id: 'B', status: 'matched', mode: 'order' },
      ],
      { A: 7, B: 9 },
    );
    expect(primaryPair(r)?.id).toBe('A');
    expect(contrastCells(r)).toBe(7);
  });

  it('is 0 when no sheet was compared', () => {
    const r = result([{ id: 'New', status: 'added', mode: 'key' }], {});
    expect(primaryPair(r)).toBeUndefined();
    expect(contrastCells(r)).toBe(0);
  });

  it('falls back to the total if the primary has no recorded baseline', () => {
    const r = result([{ id: 'Sales', status: 'matched', mode: 'key' }], { Other: 4, More: 6 });
    expect(contrastCells(r)).toBe(10);
  });
});
