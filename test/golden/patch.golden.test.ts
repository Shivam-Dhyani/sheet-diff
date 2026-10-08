import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readWorkbook } from '../../src/read/index.js';
import { planMerge } from '../../src/merge/plan.js';
import { resolveMerge } from '../../src/merge/resolve.js';
import { buildMergeLog } from '../../src/merge/log.js';
import { applyMergePatch } from '../../src/patch/index.js';
import { getCell } from '../../src/ir/sheet.js';
import type { WorkbookIR } from '../../src/index.js';
import type { Resolutions, ConflictResolution } from '../../src/merge/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '../../docs/fixtures/merge');
const expectedPath = resolve(dir, 'expected.json');
const hasFixtures = existsSync(expectedPath);

function hasSoffice(): boolean {
  try {
    execFileSync('soffice', ['--version'], { stdio: 'pipe', timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

(hasFixtures ? describe : describe.skip)('golden: patch writer — merged .xlsx', () => {
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as {
    original: string;
    copy1: { file: string; label: string };
    copy2: { file: string; label: string };
    testResolution: Record<string, unknown>;
    expectedOutputWithTestResolution: {
      invoiceCount: number;
      summaryAfterExcelRecalculates: Record<string, number>;
    };
  };
  const labels: [string, string] = [expected.copy1.label, expected.copy2.label];
  let base: WorkbookIR;
  let output: Awaited<ReturnType<typeof applyMergePatch>>;

  beforeAll(async () => {
    const rd = async (f: string): Promise<WorkbookIR> =>
      readWorkbook(new Uint8Array(readFileSync(resolve(dir, f))), { fileName: f, keepSourceBytes: true });
    base = await rd(expected.original);
    const a = await rd(expected.copy1.file);
    const b = await rd(expected.copy2.file);
    const plan = planMerge(base, a, b, { labels });
    const conflicts: Record<string, ConflictResolution> = {};
    for (const c of plan.conflicts) {
      if (!c.key) continue;
      const choice = expected.testResolution[c.key] as string | undefined;
      if (choice === undefined) continue;
      conflicts[c.id] = choice === 'delete' ? 'delete' : choice === labels[0] ? 'A' : 'B';
    }
    const resolutions: Resolutions = { conflicts };
    const changeSet = resolveMerge(base, plan, resolutions, { extendTotals: true });
    const log = buildMergeLog(plan, resolutions, labels);
    // applyMergePatch runs the self-check internally and throws on failure.
    output = await applyMergePatch(base, changeSet, { sourceLabels: labels, now: new Date(), log });
  });

  it('applies all 8 changes and blocks nothing (self-check passed)', () => {
    expect(output.applied).toHaveLength(8);
    expect(output.blocked).toHaveLength(0);
  });

  it('produces an output with a SheetLens Merge Log sheet listing 8 rows', async () => {
    const wb = await readWorkbook(output.bytes, { fileName: 'merged.xlsx' });
    expect(wb.sheets.map((s) => s.name)).toContain('SheetLens Merge Log');
    const log = wb.sheets.find((s) => s.name === 'SheetLens Merge Log')!;
    // header + 8 data rows
    let dataRows = 0;
    for (let r = 1; r < log.rows; r++) {
      if (getCell(log, wb.pool, r, 0).num >= 1 || getCell(log, wb.pool, r, 1).text !== '') dataRows++;
    }
    expect(dataRows).toBe(8);
  });

  it('has 30 invoices with the resolved cell values', async () => {
    const wb = await readWorkbook(output.bytes, { fileName: 'merged.xlsx' });
    const sr = wb.sheets.find((s) => s.name === 'Sales Register')!;
    const keyRow = new Map<string, number>();
    for (let r = 4; r < sr.rows; r++) {
      const k = getCell(sr, wb.pool, r, 0).text;
      if (k.startsWith('INV-')) keyRow.set(k, r);
    }
    expect(keyRow.size).toBe(expected.expectedOutputWithTestResolution.invoiceCount);
    expect(keyRow.has('INV-1013')).toBe(true);
    expect(keyRow.has('INV-1031')).toBe(true);
    expect(keyRow.has('INV-1019')).toBe(false);
    // INV-1003 Qty = 30 (Ravi), INV-1008 Rate stays 420 (base), INV-1022 GST% = 0.05
    expect(getCell(sr, wb.pool, keyRow.get('INV-1003')!, 6).num).toBe(30); // Qty col G
    expect(getCell(sr, wb.pool, keyRow.get('INV-1008')!, 7).num).toBe(420); // Rate col H
    expect(getCell(sr, wb.pool, keyRow.get('INV-1022')!, 9).num).toBeCloseTo(0.05);
  });

  (hasSoffice() ? it : it.skip)(
    'opens in LibreOffice and recalculates the Summary to the expected totals',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'sheetlens-patch-'));
      const inPath = join(tmp, 'merged.xlsx');
      writeFileSync(inPath, output.bytes);
      execFileSync('soffice', ['--headless', '--calc', '--convert-to', 'xlsx', '--outdir', join(tmp, 'out'), inPath], {
        stdio: 'pipe',
        timeout: 120000,
      });
      const wb = await readWorkbook(new Uint8Array(readFileSync(join(tmp, 'out', 'merged.xlsx'))), {
        fileName: 'recalc.xlsx',
      });
      const sm = wb.sheets.find((s) => s.name === 'Summary')!;
      const byLabel = new Map<string, number>();
      for (let r = 0; r < sm.rows; r++) {
        const label = getCell(sm, wb.pool, r, 0).text;
        const val = getCell(sm, wb.pool, r, 1);
        if (label) byLabel.set(label, val.num);
      }
      for (const [label, value] of Object.entries(expected.expectedOutputWithTestResolution.summaryAfterExcelRecalculates)) {
        expect(byLabel.get(label), `recalc "${label}"`).toBeCloseTo(value, 2);
      }
    },
    180000,
  );
});
