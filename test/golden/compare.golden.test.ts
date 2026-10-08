import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook } from '../../src/read/index.js';
import { compareWorkbooks } from '../../src/compare/index.js';

/**
 * Golden acceptance test (TDD §15.2). It consumes the owner's real fixtures in
 * `docs/fixtures/compare/`:
 *   - the old and new workbooks (any .xlsx/.xls/.csv names)
 *   - expected.json: { oldFile, newFile, key?, counts?, findingsByRule?,
 *                      mustNotFire?, positionalBaseline? }
 *
 * Until those files are dropped in, the suite is skipped (not failed) so the
 * rest of CI stays green.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '../../docs/fixtures/compare');
const expectedPath = resolve(fixturesDir, 'expected.json');

interface Expected {
  oldFile: string;
  newFile: string;
  key?: string;
  counts?: Record<string, number>;
  findingsByRule?: Record<string, number>;
  mustNotFire?: string[];
  positionalBaseline?: number;
}

const hasFixtures = existsSync(expectedPath);

(hasFixtures ? describe : describe.skip)('golden: compare fixtures', () => {
  const expected: Expected = hasFixtures
    ? (JSON.parse(readFileSync(expectedPath, 'utf8')) as Expected)
    : ({} as Expected);

  it('matches docs/fixtures/compare/expected.json', async () => {
    const oldBytes = new Uint8Array(readFileSync(resolve(fixturesDir, expected.oldFile)));
    const newBytes = new Uint8Array(readFileSync(resolve(fixturesDir, expected.newFile)));
    const oldWb = await readWorkbook(oldBytes, { fileName: expected.oldFile });
    const newWb = await readWorkbook(newBytes, { fileName: expected.newFile });

    const opts = expected.key
      ? { keys: Object.fromEntries((await import('../../src/compare/index.js')).analyzePair(oldWb, newWb).pairs.map((p) => [p.id, [expected.key!]])) }
      : {};
    const result = compareWorkbooks(oldWb, newWb, opts);

    if (expected.counts) {
      for (const [k, v] of Object.entries(expected.counts)) {
        expect(result.counts[k as keyof typeof result.counts]).toBe(v);
      }
    }
    if (expected.findingsByRule) {
      const byRule: Record<string, number> = {};
      for (const f of result.findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
      for (const [rule, n] of Object.entries(expected.findingsByRule)) {
        expect(byRule[rule] ?? 0).toBe(n);
      }
    }
    if (expected.mustNotFire) {
      const rules = new Set(result.findings.map((f) => f.rule));
      for (const rule of expected.mustNotFire) expect(rules.has(rule as never)).toBe(false);
    }
    if (typeof expected.positionalBaseline === 'number') {
      const total = Object.values(result.positionalBaseline).reduce((a, b) => a + b, 0);
      expect(total).toBe(expected.positionalBaseline);
    }
  });
});
