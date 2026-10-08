import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook } from '../../src/read/index.js';
import { planMerge } from '../../src/merge/plan.js';
import { resolveMerge } from '../../src/merge/resolve.js';
import { previewImpact } from '../../src/merge/impact.js';
import { buildMergeLog } from '../../src/merge/log.js';
import type { WorkbookIR } from '../../src/index.js';
import type { MergePlan, Resolutions, ConflictResolution } from '../../src/merge/types.js';

/**
 * Golden acceptance for assisted merge (TDD §15.2 / US-05). Asserts the plan,
 * the resolved change set, the impact preview, and the merge log against
 * `docs/fixtures/merge/expected.json`. The patched-output + LibreOffice
 * recalculation check (FR-MRG-06) arrives with the patch-writer increment.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '../../docs/fixtures/merge');
const expectedPath = resolve(dir, 'expected.json');
const hasFixtures = existsSync(expectedPath);

interface Expected {
  original: string;
  copy1: { file: string; label: string };
  copy2: { file: string; label: string };
  autoMergeProposals: {
    type: string;
    key: string;
    column?: string;
    from: string;
    value?: unknown;
    insertAfterKey?: string;
  }[];
  conflicts: { type: string; key: string; column?: string }[];
  testResolution: Record<string, unknown>;
  expectedOutputWithTestResolution: {
    invoiceCount: number;
    cells: { key: string; column: string; value: unknown }[];
    summaryAfterExcelRecalculates: Record<string, number>;
    ifExtendTotalsIsOff: Record<string, unknown>;
  };
}

(hasFixtures ? describe : describe.skip)('golden: merge — Sales Register Sep 2026', () => {
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as Expected;
  const labels: [string, string] = [expected.copy1.label, expected.copy2.label];
  let base: WorkbookIR;
  let plan: MergePlan;

  const sourceOf = (label: string): 'A' | 'B' => (label === labels[0] ? 'A' : 'B');

  beforeAll(async () => {
    const rd = async (f: string): Promise<WorkbookIR> =>
      readWorkbook(new Uint8Array(readFileSync(resolve(dir, f))), { fileName: f, keepSourceBytes: true });
    base = await rd(expected.original);
    const a = await rd(expected.copy1.file);
    const b = await rd(expected.copy2.file);
    plan = planMerge(base, a, b, { labels });
  });

  it('produces the expected auto-proposals', () => {
    expect(plan.proposals).toHaveLength(expected.autoMergeProposals.length);
    for (const ap of expected.autoMergeProposals) {
      const kind = ap.type === 'row_added' ? 'row_add' : 'cell';
      const got = plan.proposals.find((p) => p.key === ap.key && p.kind === kind && (!ap.column || p.column === ap.column));
      expect(got, `proposal ${ap.key} ${ap.column ?? ''}`).toBeDefined();
      expect(got!.source).toBe(sourceOf(ap.from));
      if (ap.value !== undefined) expect(got!.value).toEqual(ap.value);
      if (ap.insertAfterKey) expect(got!.afterKey).toBe(ap.insertAfterKey);
    }
  });

  it('produces the three expected conflicts', () => {
    expect(plan.conflicts).toHaveLength(expected.conflicts.length);
    for (const ec of expected.conflicts) {
      const got = plan.conflicts.find((c) => c.key === ec.key && c.type === ec.type);
      expect(got, `conflict ${ec.type} ${ec.key}`).toBeDefined();
      if (ec.column) expect(got!.column).toBe(ec.column);
    }
  });

  function resolutionsFrom(extendTotals: boolean): { resolutions: Resolutions; extendTotals: boolean } {
    const conflicts: Record<string, ConflictResolution> = {};
    for (const c of plan.conflicts) {
      if (!c.key) continue;
      const choice = expected.testResolution[c.key] as string | undefined;
      if (choice === undefined) continue;
      conflicts[c.id] = choice === 'delete' ? 'delete' : (sourceOf(choice) as ConflictResolution);
    }
    return { resolutions: { conflicts }, extendTotals };
  }

  it('resolves to the expected merged cell values', () => {
    const { resolutions } = resolutionsFrom(true);
    const cs = resolveMerge(base, plan, resolutions, { extendTotals: true });
    for (const ec of expected.expectedOutputWithTestResolution.cells) {
      // A merged value is either an explicit edit, or the base value left untouched
      // (e.g. INV-1008 Rate stays 420 because Ravi's edits were chosen).
      const edit = cs.cellEdits.find((e) => e.key === ec.key && e.column === ec.column);
      if (edit) expect(edit.value ?? edit.formula).toEqual(ec.value);
    }
    expect(cs.rowDeletes.map((d) => d.key)).toContain('INV-1019');
    expect(cs.rowInserts.map((i) => i.key).sort()).toEqual(['INV-1013', 'INV-1031']);
  });

  it('impact preview matches the recalculated Summary (extend on)', () => {
    const { resolutions } = resolutionsFrom(true);
    const cs = resolveMerge(base, plan, resolutions, { extendTotals: true });
    const impact = previewImpact(base, cs);
    const byLabel = new Map(impact.map((r) => [r.label, r.after]));
    const exp = expected.expectedOutputWithTestResolution.summaryAfterExcelRecalculates;
    for (const [label, value] of Object.entries(exp)) {
      const got = byLabel.get(label);
      expect(got, `impact for "${label}"`).toBeDefined();
      expect(typeof got === 'number' ? got : NaN).toBeCloseTo(value, 2);
    }
  });

  it('warns (via excluded rows) and under-reports when extend is off', () => {
    const { resolutions } = resolutionsFrom(false);
    const cs = resolveMerge(base, plan, resolutions, { extendTotals: false });
    expect(cs.extendRanges).toHaveLength(0);
    const impact = previewImpact(base, cs);
    const byLabel = new Map(impact.map((r) => [r.label, r.after]));
    const off = expected.expectedOutputWithTestResolution.ifExtendTotalsIsOff;
    expect(byLabel.get('Total taxable value (₹)')).toBeCloseTo(off['Total taxable value (₹)'] as number, 2);
    expect(byLabel.get('Total GST payable (₹)')).toBeCloseTo(off['Total GST payable (₹)'] as number, 2);
  });

  it('builds a Merge Log with 8 applied changes (5 auto + 3 resolved)', () => {
    const { resolutions } = resolutionsFrom(true);
    const log = buildMergeLog(plan, resolutions, labels);
    expect(log).toHaveLength(8);
    expect(log.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(log.filter((r) => r.decision === 'auto')).toHaveLength(5);
    expect(log.filter((r) => r.decision.startsWith('resolved'))).toHaveLength(3);
  });

  it('refuses to resolve while a conflict is open (MERGE_UNRESOLVED)', () => {
    expect(() => resolveMerge(base, plan, { conflicts: {} }, { extendTotals: false })).toThrowError(
      /Resolve 3 conflict/,
    );
  });
});
