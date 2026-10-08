import { describe, it, expect, beforeAll } from 'vitest';
import { readWorkbook } from '../../src/read/index.js';
import { compareWorkbooks, analyzePair } from '../../src/compare/index.js';
import type { CompareResult, WorkbookIR } from '../../src/index.js';
import { buildXlsx, type SheetSpec } from '../helpers/build.js';

// Sales Register columns: Invoice No | Qty | Rate | Amount(=Qty*Rate)
// Summary: a single SUM over the Amount column of the OLD data range.
function salesRegister(rows: [string, number, number, { f: string; v: number }][]): SheetSpec {
  return {
    name: 'Sales Register',
    rows: [['Invoice No', 'Qty', 'Rate', 'Amount'], ...rows],
  };
}

function summary(sumFormula: string, total: number): SheetSpec {
  return {
    name: 'Summary',
    rows: [
      ['Label', 'Value'],
      ['Total Amount', { f: sumFormula, v: total }],
    ],
  };
}

const OLD = buildXlsx([
  salesRegister([
    ['INV-1001', 10, 5, { f: 'B2*C2', v: 50 }],
    ['INV-1002', 20, 5, { f: 'B3*C3', v: 100 }],
    ['INV-1003', 30, 5, { f: 'B4*C4', v: 150 }],
    ['INV-1004', 40, 5, { f: 'B5*C5', v: 200 }],
  ]),
  summary("SUM('Sales Register'!D2:D5)", 500),
]);

// New: INV-1002 Qty 20→25 (value edit + Amount recalculated); INV-1003 Amount
// formula typed over with 160 (CHK-01); INV-1005 appended below the Summary SUM
// range (row added → CHK-02).
const NEW_TYPED = buildXlsx([
  {
    name: 'Sales Register',
    rows: [
      ['Invoice No', 'Qty', 'Rate', 'Amount'],
      ['INV-1001', 10, 5, { f: 'B2*C2', v: 50 }],
      ['INV-1002', 25, 5, { f: 'B3*C3', v: 125 }],
      ['INV-1003', 30, 5, 160],
      ['INV-1004', 40, 5, { f: 'B5*C5', v: 200 }],
      ['INV-1005', 12, 5, { f: 'B6*C6', v: 60 }],
    ],
  },
  summary("SUM('Sales Register'!D2:D5)", 535),
]);

describe('compare pipeline (end-to-end)', () => {
  let oldWb: WorkbookIR;
  let newWb: WorkbookIR;
  let result: CompareResult;

  beforeAll(async () => {
    oldWb = await readWorkbook(OLD, { fileName: 'old.xlsx' });
    newWb = await readWorkbook(NEW_TYPED, { fileName: 'new.xlsx' });
    result = compareWorkbooks(oldWb, newWb);
  });

  it('reads the workbook into IR with both sheets', () => {
    expect(oldWb.sheets.map((s) => s.name)).toEqual(['Sales Register', 'Summary']);
    expect(oldWb.sheets[0]!.rows).toBeGreaterThanOrEqual(5);
  });

  it('detects "Invoice No" as a high-confidence key', () => {
    const analysis = analyzePair(oldWb, newWb);
    const sales = analysis.pairs.find((p) => p.newName === 'Sales Register')!;
    expect(sales.key.mode).toBe('key');
    expect(sales.key.columns).toEqual(['Invoice No']);
    expect(sales.key.confidence).toBe('high');
  });

  it('counts one added row and no removed rows', () => {
    expect(result.counts.rowsAdded).toBe(1);
    expect(result.counts.rowsRemoved).toBe(0);
  });

  it('flags the formula overwritten by a typed value (CHK-01)', () => {
    const chk01 = result.findings.filter((f) => f.rule === 'CHK-01');
    expect(chk01).toHaveLength(1);
    expect(chk01[0]!.key).toBe('INV-1003');
    expect(chk01[0]!.severity).toBe('high');
    // The engine computed the formula's expected value on the new inputs.
    expect(chk01[0]!.message).toMatch(/150/);
  });

  it('treats the Qty edit as a real change and the Amount as recalculated', () => {
    const edits = result.pairs
      .flatMap((p) => p.cellChanges)
      .filter((c) => c.key === 'INV-1002');
    const qty = edits.find((c) => c.column === 'Qty');
    const amount = edits.find((c) => c.column === 'Amount');
    expect(qty?.kind).toBe('value_changed');
    expect(amount?.kind).toBe('recalculated');
    // recalculated cells are not counted as real changes
    expect(result.counts.recalculated).toBeGreaterThanOrEqual(1);
  });

  it('detects that the Summary total omits the new row (CHK-02)', () => {
    const chk02 = result.findings.filter((f) => f.rule === 'CHK-02');
    expect(chk02.length).toBeGreaterThanOrEqual(1);
    expect(chk02[0]!.message).toMatch(/INV-1005/);
  });

  it('reports a positional baseline larger than the real-change count', () => {
    const positional = Object.values(result.positionalBaseline).reduce((a, b) => a + b, 0);
    expect(positional).toBeGreaterThan(0);
    expect(result.counts.realChanges).toBeGreaterThanOrEqual(2);
  });

  it('is deterministic: same inputs → identical findings', () => {
    const again = compareWorkbooks(oldWb, newWb);
    expect(again.findings.map((f) => f.id)).toEqual(result.findings.map((f) => f.id));
  });

  it('compare(x, x) finds no real changes', () => {
    const same = compareWorkbooks(oldWb, oldWb);
    expect(same.counts.realChanges).toBe(0);
    expect(same.findings.filter((f) => f.severity === 'high')).toHaveLength(0);
  });
});
