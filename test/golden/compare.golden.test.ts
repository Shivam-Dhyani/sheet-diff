import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook } from '../../src/read/index.js';
import { compareWorkbooks } from '../../src/compare/index.js';
import type { CompareResult, Finding } from '../../src/index.js';

/**
 * Golden acceptance test (TDD §15.2, SM-1). Consumes the owner's real fixtures
 * in `docs/fixtures/compare/` and asserts a subset match against the ground
 * truth in `expected.json`. Skipped (not failed) until the fixtures exist.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '../../docs/fixtures/compare');
const expectedPath = resolve(dir, 'expected.json');
const hasFixtures = existsSync(expectedPath);

interface ExpectedCellChange {
  key: string;
  column: string;
  kind: string;
  old?: unknown;
  new?: unknown;
  oldFormula?: string;
}
interface ExpectedSheet {
  name: string;
  status: string;
  cellChanges?: ExpectedCellChange[];
}
interface ExpectedCheck {
  rule: string;
  severity: string;
  sheet?: string;
  key?: string;
  column?: string;
  excludedKeys?: string[];
  removedKey?: string;
  changedKey?: string;
}
interface ExpectedFlag {
  rule: string;
  key: string;
  column: string;
}
interface Expected {
  old: string;
  new: string;
  sheets: ExpectedSheet[];
  checks: ExpectedCheck[];
  flags: ExpectedFlag[];
  mustNotFire: string[];
  summaryCounts: {
    high: number;
    rowsAdded: number;
    rowsRemoved: number;
    cellsEditedByHand: number;
    formulasOverwritten: number;
    sheetsAdded: number;
  };
  positionalBaseline: Record<string, number | string>;
}

(hasFixtures ? describe : describe.skip)('golden: compare — Sales Register Sep 2026', () => {
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as Expected;
  let result: CompareResult;

  const byRule = (rule: string): Finding[] => result.findings.filter((f) => f.rule === rule);

  // Load + compare once.
  const load = async (): Promise<CompareResult> => {
    const oldWb = await readWorkbook(new Uint8Array(readFileSync(resolve(dir, expected.old))), {
      fileName: expected.old,
    });
    const newWb = await readWorkbook(new Uint8Array(readFileSync(resolve(dir, expected.new))), {
      fileName: expected.new,
    });
    return compareWorkbooks(oldWb, newWb);
  };

  it('matches summary counts', async () => {
    result = await load();
    expect(result.counts.needsAttention).toBe(expected.summaryCounts.high);
    expect(result.counts.rowsAdded).toBe(expected.summaryCounts.rowsAdded);
    expect(result.counts.rowsRemoved).toBe(expected.summaryCounts.rowsRemoved);
    expect(result.counts.cellsEditedByHand).toBe(expected.summaryCounts.cellsEditedByHand);
    expect(result.counts.formulasOverwritten).toBe(expected.summaryCounts.formulasOverwritten);
    const sheetsAdded = result.pairs.filter((p) => p.status === 'added').length;
    expect(sheetsAdded).toBe(expected.summaryCounts.sheetsAdded);
  });

  it('fires every expected risk check (rule + key)', async () => {
    result ??= await load();
    for (const chk of expected.checks) {
      const matches = byRule(chk.rule);
      expect(matches.length, `${chk.rule} should fire`).toBeGreaterThanOrEqual(1);
      const key = chk.key ?? chk.changedKey ?? chk.removedKey;
      if (key) {
        expect(
          matches.some((f) => f.key === key || (f.data['removedKey'] as string) === key),
          `${chk.rule} should fire for ${key}`,
        ).toBe(true);
      }
    }
  });

  it('CHK-02 excludes INV-1031 from the Summary totals', async () => {
    result ??= await load();
    const chk02 = byRule('CHK-02');
    expect(chk02.length).toBe(1);
    expect(JSON.stringify(chk02[0]!.data['excludedKeys'])).toContain('INV-1031');
  });

  it('does not fire the mustNotFire rules', async () => {
    result ??= await load();
    for (const rule of expected.mustNotFire) {
      expect(byRule(rule), `${rule} must not fire`).toHaveLength(0);
    }
  });

  it('reports the expected hand edits on each sheet', async () => {
    result ??= await load();
    for (const sheet of expected.sheets) {
      if (!sheet.cellChanges || sheet.cellChanges.length === 0) continue;
      const pair = result.pairs.find((p) => p.newName === sheet.name);
      expect(pair, `pair for ${sheet.name}`).toBeDefined();
      for (const ec of sheet.cellChanges) {
        const got = pair!.cellChanges.find((c) => c.key === ec.key && c.column === ec.column);
        expect(got, `${sheet.name} ${ec.key}/${ec.column}`).toBeDefined();
        expect(got!.kind).toBe(ec.kind);
      }
    }
  });

  it('attaches CHK-08 large-change flags to the right cells', async () => {
    result ??= await load();
    for (const flag of expected.flags) {
      const pair = result.pairs.find((p) => p.cellChanges.some((c) => c.key === flag.key));
      const change = pair?.cellChanges.find((c) => c.key === flag.key && c.column === flag.column);
      expect(change, `${flag.key}/${flag.column}`).toBeDefined();
      expect(change!.flags).toContain('large_change');
    }
  });

  it('matches the positional baseline exactly (SM-1 contrast line)', async () => {
    result ??= await load();
    for (const [sheet, value] of Object.entries(expected.positionalBaseline)) {
      if (typeof value !== 'number') continue;
      const pair = result.pairs.find((p) => p.newName === sheet || p.oldName === sheet);
      expect(pair, `pair for ${sheet}`).toBeDefined();
      expect(result.positionalBaseline[pair!.id]).toBe(value);
    }
  });

  it('reports no real changes on the Summary sheet (ranges cancel out)', async () => {
    result ??= await load();
    const summary = result.pairs.find((p) => p.newName === 'Summary');
    const real = summary!.cellChanges.filter(
      (c) => c.kind !== 'recalculated' && c.kind !== 'format_changed',
    );
    expect(real).toHaveLength(0);
  });
});
