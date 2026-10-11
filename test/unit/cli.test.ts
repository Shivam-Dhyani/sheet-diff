import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { buildXlsx, type CellSpec } from '../helpers/build.js';
import { readWorkbook, getCell } from '../../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const dir = resolve(root, 'docs/fixtures/compare');
const has = existsSync(resolve(dir, 'expected.json'));

/** Run the real CLI source (via tsx) and return stdout. */
function cli(...args: string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx', 'bin/cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

(has ? describe : describe.skip)('CLI (compare fixture)', () => {
  const oldFile = resolve(dir, 'Sales_Register_Sep2026_v1.xlsx');
  const newFile = resolve(dir, 'Sales_Register_Sep2026_FINAL.xlsx');

  it('prints the same headline and contrast figures as the report model (89, not 92)', () => {
    const out = cli(oldFile, newFile);
    expect(out).toContain('8 real change(s) found — 4 need your attention.');
    // The Summary sheet's 3 same-address differences must not be added in.
    expect(out).toContain('would flag 89 cells');
    expect(out).not.toContain('would flag 92 cells');
  }, 30_000);
});

// `merge --resolve` must never guess: a wrong answer would overwrite someone's
// edit without telling anyone.
const mergeDir = resolve(root, 'docs/fixtures/merge');
const hasMerge = existsSync(resolve(mergeDir, 'expected.json'));

/** Run the CLI, returning exit status and output instead of throwing. */
function cliRun(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'bin/cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

(hasMerge ? describe : describe.skip)('CLI merge --resolve (merge fixture)', () => {
  const f = (n: string): string => resolve(mergeDir, `Sales_Register_Sep2026_${n}.xlsx`);
  const base = ['merge', f('ORIGINAL'), f('RAVI'), f('PRIYA')];
  const tmp = mkdtempSync(join(tmpdir(), 'sheet-diff-cli-'));
  const out = join(tmp, 'merged.xlsx');
  const goodSpecs = ['INV-1003=Copy1', 'INV-1008=Copy1', 'INV-1019=delete'];
  const flags = (specs: string[]): string[] => specs.flatMap((s) => ['--resolve', s]);
  const good = flags(goodSpecs);

  // Never let one test's output (or a regression that wrongly writes a file) leak into the next.
  afterEach(() => rmSync(out, { force: true }));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('writes the merged file when every answer is valid', () => {
    const r = cliRun(...base, ...good, '--extend-totals', '--out', out);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/8 change\(s\) applied/);
    expect(existsSync(out)).toBe(true);
  });

  // Copy 1 (Ravi) deleted INV-1019 and Copy 2 (Priya) edited it. CopyN must mean
  // "take that copy's side": the old CLI turned Copy1 into "keep the edits".
  it.each([
    ['delete', false],
    ['Copy1', false], // Ravi deleted it → the row is gone
    ['Copy2', true], //  Priya edited it → the row stays, with her edit
  ])('INV-1019=%s on a delete-vs-edit conflict → row kept: %s', async (answer, kept) => {
    const specs = ['INV-1003=Copy1', 'INV-1008=Copy1', `INV-1019=${answer}`];
    const r = cliRun(...base, ...flags(specs), '--out', out);
    expect(r.status).toBe(0);

    const wb = await readWorkbook(new Uint8Array(readFileSync(out)), { fileName: 'merged.xlsx' });
    const sheet = wb.sheets.find((s) => s.name === 'Sales Register')!;
    let rowText: string[] | null = null;
    for (let row = 0; row < sheet.rows; row++) {
      if (getCell(sheet, wb.pool, row, 0).text === 'INV-1019') {
        rowText = Array.from({ length: sheet.cols }, (_, c) => getCell(sheet, wb.pool, row, c).text);
      }
    }
    expect(rowText !== null).toBe(kept);
    if (kept) expect(rowText).toContain('Shah Electricals Pvt Ltd'); // Priya's edit survived
  });

  it.each([
    ['an unknown choice (used to be silently Copy 1)', 'INV-1003=Ravi', /Unknown choice "Ravi"/],
    ['an unknown key (a typo)', 'INV-1O03=Copy1', /no conflict has that key/],
    ['delete on a cell conflict (used to silently pick Copy 2)', 'INV-1003=delete', /not a deleted row/],
    ['a malformed argument', 'INV-1003', /expected KEY=CHOICE/],
  ])('refuses %s: exit 2, clear message, nothing written', (_name, spec, message) => {
    // Replace the INV-1003 answer with the bad one; keep the other two valid.
    const r = cliRun(...base, ...flags([spec, ...goodSpecs.slice(1)]), '--out', out);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses a duplicate answer for one key', () => {
    const r = cliRun(...base, ...good, '--resolve', 'INV-1003=Copy2', '--out', out);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/more than once/);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses --resolve without --out instead of ignoring it', () => {
    const r = cliRun(...base, ...good);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/only takes effect together with --out/);
  });

  it('still reports undecided conflicts (not a usage error)', () => {
    const r = cliRun(...base, ...flags(['INV-1003=Copy1']), '--out', out);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/MERGE_UNRESOLVED/);
    expect(existsSync(out)).toBe(false);
  });
}, 60_000);

// Both copies add INV-4 with different content: an add/add conflict. The shipped fixtures
// have none, so build the three files here.
describe('CLI merge --resolve on an add/add conflict', () => {
  const header: CellSpec[] = ['Invoice No', 'Customer', 'Qty', 'Rate', 'Amount'];
  const sale = (n: number, id: string, who: string, qty: number): CellSpec[] => [
    id, who, qty, 100, { f: `C${n}*D${n}`, v: qty * 100 },
  ];
  const book = (rows: CellSpec[][]): Uint8Array =>
    buildXlsx([
      { name: 'Sales', rows: [header, ...rows] },
      { name: 'Summary', rows: [['Total', { f: 'SUM(Sales!E2:E4)', v: 0 }], ['Count', { f: 'COUNT(Sales!E2:E4)', v: 3 }]] },
    ]);
  const orig = [sale(2, 'INV-1', 'Alpha', 2), sale(3, 'INV-2', 'Beta', 3), sale(4, 'INV-3', 'Gamma', 1)];

  const tmp = mkdtempSync(join(tmpdir(), 'sheet-diff-addadd-'));
  const files = ['orig', 'ravi', 'priya'].map((n) => join(tmp, `${n}.xlsx`));
  writeFileSync(files[0]!, book(orig));
  writeFileSync(files[1]!, book([...orig, sale(5, 'INV-4', 'Delta (Ravi)', 5)]));
  writeFileSync(files[2]!, book([...orig, sale(5, 'INV-4', 'Delta (Priya)', 7)]));
  const out = join(tmp, 'merged.xlsx');
  const run = (...resolve: string[]) =>
    cliRun('merge', ...files, ...resolve.flatMap((s) => ['--resolve', s]), '--extend-totals', '--out', out);

  afterEach(() => rmSync(out, { force: true }));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** [key, customer] for every row of Sales in the merged file. */
  async function salesRows(): Promise<string[][]> {
    const wb = await readWorkbook(new Uint8Array(readFileSync(out)), { fileName: 'merged.xlsx' });
    const s = wb.sheets.find((x) => x.name === 'Sales')!;
    const rows: string[][] = [];
    for (let r = 1; r < s.rows; r++) {
      const key = getCell(s, wb.pool, r, 0).text;
      if (key) rows.push([key, getCell(s, wb.pool, r, 1).text]);
    }
    return rows;
  }

  it('lists the conflict and how to answer it when nothing is resolved', () => {
    const r = cliRun('merge', ...files);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1 conflict\(s\) to resolve/);
    expect(r.stdout).toMatch(/\[ADD_ADD\] INV-4/);
    expect(r.stdout).toMatch(/both:NEWKEY/);
  });

  it.each([
    ['Copy1', [['INV-4', 'Delta (Ravi)']]],
    ['Copy2', [['INV-4', 'Delta (Priya)']]],
    [
      'both:INV-4-B',
      [
        ['INV-4', 'Delta (Ravi)'],
        ['INV-4-B', 'Delta (Priya)'],
      ],
    ],
  ])('INV-4=%s keeps the right row(s) in the merged file', async (answer, expected) => {
    const r = run(`INV-4=${answer}`);
    expect(r.status).toBe(0);
    expect((await salesRows()).slice(3)).toEqual(expected);
  });

  it.each([
    ['delete (it was added, not deleted)', 'INV-4=delete', 2, /ADD_ADD conflict/],
    ['both: with no key', 'INV-4=both:', 2, /needs the new key/],
    ['a new key equal to the old one', 'INV-4=both:INV-4', 2, /must differ/],
    ['a new key that is already a row in the Original', 'INV-4=both:INV-2', 2, /"INV-2" is already used/],
  ])('refuses %s: exit %i, nothing written', (_name, spec, status, message) => {
    const r = run(spec);
    expect(r.status).toBe(status);
    expect(r.stderr).toMatch(message);
    expect(existsSync(out)).toBe(false);
  });
});
