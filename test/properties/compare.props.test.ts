import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readWorkbook } from '../../src/read/index.js';
import { compareWorkbooks } from '../../src/compare/index.js';
import { buildXlsx, type CellSpec } from '../helpers/build.js';

/** A random sales-register-like table with a unique key column. */
const tableArb = fc.array(
  fc.record({
    qty: fc.integer({ min: 1, max: 999 }),
    rate: fc.integer({ min: 1, max: 99 }),
  }),
  { minLength: 1, maxLength: 12 },
);

function toBytes(rows: { qty: number; rate: number }[]): Uint8Array {
  const data: CellSpec[][] = [['Invoice No', 'Qty', 'Rate', 'Amount']];
  rows.forEach((r, i) => {
    const rowNum = i + 2;
    data.push([`INV-${1000 + i}`, r.qty, r.rate, { f: `B${rowNum}*C${rowNum}`, v: r.qty * r.rate }]);
  });
  return buildXlsx([{ name: 'Sales Register', rows: data }]);
}

describe('compare properties (fast-check)', () => {
  it('compare(x, x) reports no real changes', async () => {
    await fc.assert(
      fc.asyncProperty(tableArb, async (rows) => {
        const bytes = toBytes(rows);
        const wb = await readWorkbook(bytes, { fileName: 'x.xlsx' });
        const result = compareWorkbooks(wb, wb);
        expect(result.counts.realChanges).toBe(0);
        expect(result.findings.filter((f) => f.severity === 'high')).toHaveLength(0);
      }),
      { numRuns: 30 },
    );
  });

  it('added in compare(a,b) equals removed in compare(b,a)', async () => {
    await fc.assert(
      fc.asyncProperty(tableArb, tableArb, async (a, b) => {
        const wbA = await readWorkbook(toBytes(a), { fileName: 'a.xlsx' });
        const wbB = await readWorkbook(toBytes(b), { fileName: 'b.xlsx' });
        const ab = compareWorkbooks(wbA, wbB);
        const ba = compareWorkbooks(wbB, wbA);
        expect(ab.counts.rowsAdded).toBe(ba.counts.rowsRemoved);
        expect(ab.counts.rowsRemoved).toBe(ba.counts.rowsAdded);
      }),
      { numRuns: 25 },
    );
  });
});
