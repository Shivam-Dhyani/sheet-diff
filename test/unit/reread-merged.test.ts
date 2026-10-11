import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readWorkbook,
  planMerge,
  resolveMerge,
  buildMergeLog,
  applyMergePatch,
  compareWorkbooks,
  getCell,
  type WorkbookIR,
  type CompareResult,
  type Resolutions,
} from '../../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '../../docs/fixtures/merge');
const has = existsSync(resolve(dir, 'expected.json'));

/**
 * SheetLens's merge output has no cached values (Excel recalculates it on open). Re-opening it —
 * say, to compare it with its Original — must still see every formula, not an emptied sheet.
 */
(has ? describe : describe.skip)('re-reading a merged file (formulas without cached values)', () => {
  let original: WorkbookIR;
  let merged: WorkbookIR;
  let result: CompareResult;

  beforeAll(async () => {
    const load = async (n: string, keep = false) =>
      readWorkbook(new Uint8Array(readFileSync(resolve(dir, `Sales_Register_Sep2026_${n}.xlsx`))), {
        fileName: `${n}.xlsx`,
        keepSourceBytes: keep,
      });
    original = await load('ORIGINAL', true);
    const plan = planMerge(original, await load('RAVI'), await load('PRIYA'), { labels: ['Ravi', 'Priya'] });
    const byKey: Record<string, 'A' | 'delete'> = { 'INV-1003': 'A', 'INV-1008': 'A', 'INV-1019': 'delete' };
    const resolutions: Resolutions = {
      conflicts: Object.fromEntries(plan.conflicts.map((c) => [c.id, byKey[c.key!]!])),
    };
    const out = await applyMergePatch(
      original,
      resolveMerge(original, plan, resolutions, { extendTotals: true }),
      { sourceLabels: ['Ravi', 'Priya'], log: buildMergeLog(plan, resolutions, ['Ravi', 'Priya']) },
    );
    merged = await readWorkbook(out.bytes, { fileName: 'merged.xlsx' });
    result = compareWorkbooks(original, merged);
  });

  const cellAt = (wb: WorkbookIR, sheet: string, a1: string) => {
    const s = wb.sheets.find((x) => x.name === sheet)!;
    const col = a1.charCodeAt(0) - 65;
    return getCell(s, wb.pool, Number(a1.slice(1)) - 1, col);
  };

  it('keeps the Summary formulas, with the extended ranges', () => {
    const formulas = (wb: WorkbookIR) =>
      wb.sheets.find((s) => s.name === 'Summary')!.formula.size;
    expect(formulas(merged)).toBe(formulas(original)); // none lost
    expect(formulas(merged)).toBeGreaterThan(0);
  });

  it('treats the many formulas with no saved value as recalculated, not as real changes', () => {
    const kinds: Record<string, number> = {};
    for (const p of result.pairs) for (const c of p.cellChanges) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
    expect(kinds['recalculated']).toBeGreaterThan(50);
    // Only what the merge really did: the input edits, plus the 4 totals that "extend totals"
    // widened. No formula may turn into a blank or a typed value.
    expect(kinds['formula_overwritten'] ?? 0).toBe(0);
    expect(kinds['formula_removed'] ?? 0).toBe(0);
    expect(kinds['formula_changed']).toBe(4);
    expect(result.counts.formulasOverwritten).toBe(0);
  });

  it('describes a widened total by its formula, not as "→ (blank)"', () => {
    const edits = result.findings.filter((f) => f.rule === 'CELL_EDIT' && f.data['kind'] === 'formula_changed');
    expect(edits).toHaveLength(4);
    for (const f of edits) {
      expect(f.message).toMatch(/→ =(COUNTA|SUM|SUMIF)\(/);
      expect(f.message).not.toMatch(/\(blank\)/);
      expect(f.message).toMatch(/Excel will calculate it/);
    }
  });

  it('still reports the genuine input edits with their values', () => {
    const msgs = result.findings.filter((f) => f.rule === 'CELL_EDIT').map((f) => f.message);
    expect(msgs).toContain('Qty for INV-1003: 25 → 30.');
    expect(msgs).toContain('Qty for INV-1008: 90 → 45.');
    expect(cellAt(merged, 'Sales Register', 'A5').text).toBeTypeOf('string');
  });
});
