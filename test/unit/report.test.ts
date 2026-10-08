import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook } from '../../src/read/index.js';
import { compareWorkbooks } from '../../src/compare/index.js';
import { buildReportModel, buildCopySummary } from '../../src/report/index.js';
import { RowState, type CompareResult, type WorkbookIR, type ReportModel } from '../../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '../../docs/fixtures/compare');
const has = existsSync(resolve(dir, 'expected.json'));

(has ? describe : describe.skip)('report model (compare fixture)', () => {
  let result: CompareResult;
  let model: ReportModel;

  beforeAll(async () => {
    const oldWb: WorkbookIR = await readWorkbook(
      new Uint8Array(readFileSync(resolve(dir, 'Sales_Register_Sep2026_v1.xlsx'))),
      { fileName: 'Sales_Register_Sep2026_v1.xlsx' },
    );
    const newWb: WorkbookIR = await readWorkbook(
      new Uint8Array(readFileSync(resolve(dir, 'Sales_Register_Sep2026_FINAL.xlsx'))),
      { fileName: 'Sales_Register_Sep2026_FINAL.xlsx' },
    );
    result = compareWorkbooks(oldWb, newWb);
    model = buildReportModel(result, oldWb, newWb, { now: new Date('2026-10-08') });
  });

  it('Overview carries the headline counts and contrast', () => {
    expect(model.overview.counts.needsAttention).toBe(4);
    expect(model.overview.counts.rowsAdded).toBe(2);
    expect(model.overview.counts.rowsRemoved).toBe(1);
    expect(model.overview.counts.cellsEditedByHand).toBe(4);
    expect(model.overview.counts.formulasOverwritten).toBe(1);
    expect(model.overview.contrastCells).toBe(89);
    expect(model.overview.attention).toHaveLength(4);
    expect(model.meta.matchedBy).toMatch(/Invoice No/);
  });

  it('All Changes is severity-ordered with the four High findings first', () => {
    expect(model.allChanges.slice(0, 4).every((c) => c.risk === 'high')).toBe(true);
    const highKeys = model.allChanges.filter((c) => c.risk === 'high').map((c) => c.key);
    expect(highKeys).toEqual(expect.arrayContaining(['INV-1015', 'INV-1031', 'INV-1019', 'INV-1029']));
    const chk01 = model.allChanges.find((c) => c.rule === 'CHK-01');
    expect(chk01?.old).toBeCloseTo(1036.8);
    expect(chk01?.new).toBeCloseTo(1063.8);
  });

  it('marks the Sales Register rows with their status', () => {
    const marked = model.markedSheets.find((m) => m.name === 'Sales Register')!;
    const byKey = new Map(marked.rows.map((r) => [r.key, r]));
    expect(byKey.get('INV-1004')?.status).toBe(RowState.Changed);
    expect(byKey.get('INV-1008')?.status).toBe(RowState.Changed);
    expect(byKey.get('INV-1013')?.status).toBe(RowState.Added);
    expect(byKey.get('INV-1031')?.status).toBe(RowState.Added);
    expect(marked.removed.map((r) => r.key)).toContain('INV-1019');
  });

  it('flags a changed cell with its old value', () => {
    const marked = model.markedSheets.find((m) => m.name === 'Sales Register')!;
    const gstinCol = marked.columns.indexOf('Customer GSTIN');
    const row = marked.rows.find((r) => r.key === 'INV-1004')!;
    expect(row.cells[gstinCol]!.changed).toBe(true);
    expect(row.cells[gstinCol]!.oldValue).toBe('24AAMFD6041L1Z7');
    expect(row.cells[gstinCol]!.value).toBe('24AAMFD6041L1Z8');
  });

  it('copy summary is High-first and ≤ 1000 chars', () => {
    const s = buildCopySummary(result);
    expect(s.length).toBeLessThanOrEqual(1000);
    expect(s).toMatch(/4 need attention/);
    expect(s).toContain('INV-1015');
  });
});
