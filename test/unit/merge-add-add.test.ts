import { describe, it, expect, beforeAll } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildXlsx, type CellSpec } from '../helpers/build.js';
import {
  readWorkbook,
  planMerge,
  resolveMerge,
  previewImpact,
  buildMergeLog,
  applyMergePatch,
  getCell,
  isSheetDiffError,
  type WorkbookIR,
  type MergePlan,
  type Conflict,
  type Resolutions,
  type ConflictResolution,
} from '../../src/index.js';
import { addAddInserts, assertChoiceFits } from '../../src/merge/add-add.js';

const LABELS: [string, string] = ['Ravi', 'Priya'];
const HEADER: CellSpec[] = ['Invoice No', 'Customer', 'Qty', 'Rate', 'Amount'];

/** A sales row whose Amount is a live formula on its own row (Excel row = index + 1). */
const sale = (n: number, id: string, customer: string, qty: number, rate = 100): CellSpec[] => [
  id,
  customer,
  qty,
  rate,
  { f: `C${n}*D${n}`, v: qty * rate },
];

/**
 * Original: INV-1..3 (Amounts 200 + 300 + 100 = 600) and a Summary that totals them.
 * `summaryLast` is the last row the Summary formulas cover. Like Excel, appending a
 * row *below* the range leaves it at 4 (the totals "miss" the new row); only a row
 * inserted *inside* the range grows it.
 */
function workbook(rows: CellSpec[][], summaryLast = 4): Uint8Array {
  const last = summaryLast;
  return buildXlsx([
    { name: 'Sales', rows: [HEADER, ...rows] },
    {
      name: 'Summary',
      rows: [
        ['Total amount', { f: `SUM(Sales!E2:E${last})`, v: 0 }],
        ['Invoices', { f: `COUNT(Sales!E2:E${last})`, v: rows.length }],
      ],
    },
  ]);
}

/**
 * All worksheet XML of an .xlsx, concatenated. Formulas are checked here rather
 * than by re-reading: the patch leaves formula cells without a cached value (Excel
 * recalculates on open), and the reader skips a formula cell that has no value.
 */
function worksheetXml(bytes: Uint8Array): string {
  const parts = unzipSync(bytes);
  return Object.keys(parts)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()
    .map((n) => strFromU8(parts[n]!))
    .join('\n');
}

const ORIGINAL = [sale(2, 'INV-1', 'Alpha', 2), sale(3, 'INV-2', 'Beta', 3), sale(4, 'INV-3', 'Gamma', 1)];

async function load(bytes: Uint8Array, name: string, keep = false): Promise<WorkbookIR> {
  return readWorkbook(bytes, { fileName: name, keepSourceBytes: keep });
}

/** Both copies add INV-4 after INV-3, with different customers and quantities. */
describe('ADD_ADD — both copies add the same invoice', () => {
  let base: WorkbookIR;
  let plan: MergePlan;
  let conflict: Conflict;

  beforeAll(async () => {
    base = await load(workbook(ORIGINAL), 'orig.xlsx', true);
    const a = await load(workbook([...ORIGINAL, sale(5, 'INV-4', 'Delta (Ravi)', 5)]), 'ravi.xlsx');
    const b = await load(workbook([...ORIGINAL, sale(5, 'INV-4', 'Delta (Priya)', 7)]), 'priya.xlsx');
    plan = planMerge(base, a, b, { labels: LABELS });
    conflict = plan.conflicts[0]!;
  });

  const resolutions = (choice: ConflictResolution): Resolutions => ({
    conflicts: { [conflict.id]: choice },
  });

  const cellOf = (wb: WorkbookIR, sheet: string, r: number, c: number) =>
    getCell(wb.sheets.find((s) => s.name === sheet)!, wb.pool, r, c);

  /** Write the patch, read it back, and return Sales' [key, customer, qty, amount formula] per row. */
  async function patched(choice: ConflictResolution, extendTotals = true) {
    const res = resolutions(choice);
    const cs = resolveMerge(base, plan, res, { extendTotals });
    const out = await applyMergePatch(base, cs, {
      sourceLabels: LABELS,
      log: buildMergeLog(plan, res, LABELS),
    });
    const wb = await readWorkbook(out.bytes, { fileName: 'merged.xlsx' });
    const sales = wb.sheets.find((s) => s.name === 'Sales')!;
    const rows = [];
    for (let r = 1; r < sales.rows; r++) {
      const key = cellOf(wb, 'Sales', r, 0).text;
      if (key) {
        rows.push({
          key,
          customer: cellOf(wb, 'Sales', r, 1).text,
          qty: cellOf(wb, 'Sales', r, 2).num,
        });
      }
    }
    return { rows, wb, out, cs, xml: worksheetXml(out.bytes) };
  }

  it('is planned as one ADD_ADD conflict that remembers both sides', () => {
    expect(plan.proposals).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(1);
    expect(conflict.type).toBe('ADD_ADD');
    expect(conflict.key).toBe('INV-4');
    expect(conflict.afterKey).toBe('INV-3');
    expect(conflict.bAfterKey).toBe('INV-3');
    expect(conflict.aSourceRow).toBeTypeOf('number');
    expect(conflict.bSourceRow).toBeTypeOf('number');
    expect(conflict.keyColumns).toEqual(['Invoice No']);
  });

  it("'A' inserts Copy 1's row only", async () => {
    const { rows } = await patched('A');
    expect(rows.map((r) => r.key)).toEqual(['INV-1', 'INV-2', 'INV-3', 'INV-4']);
    expect(rows[3]).toMatchObject({ customer: 'Delta (Ravi)', qty: 5 });
  });

  it("'B' inserts Copy 2's row only", async () => {
    const { rows } = await patched('B');
    expect(rows.map((r) => r.key)).toEqual(['INV-1', 'INV-2', 'INV-3', 'INV-4']);
    expect(rows[3]).toMatchObject({ customer: 'Delta (Priya)', qty: 7 });
  });

  it('keep-both inserts two rows, each under its own key, in order', async () => {
    const { rows, cs } = await patched({ keepBoth: { aKey: 'INV-4', bKey: 'INV-4-B' } });
    expect(rows.map((r) => r.key)).toEqual(['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-4-B']);
    expect(rows[3]).toMatchObject({ customer: 'Delta (Ravi)', qty: 5 });
    expect(rows[4]).toMatchObject({ customer: 'Delta (Priya)', qty: 7 });
    expect(cs.rowInserts.map((i) => [i.key, i.source])).toEqual([
      ['INV-4', 'A'],
      ['INV-4-B', 'B'],
    ]);
  });

  it("re-anchors each inserted row's own formula to the row it lands on", async () => {
    const { xml } = await patched({ keepBoth: { aKey: 'INV-4', bKey: 'INV-4-B' } });
    // Both copies had the formula on their row 5; the kept rows land on rows 5 and 6.
    expect(xml).toContain('<c r="E5"><f>C5*D5</f></c>');
    expect(xml).toContain('<c r="E6"><f>C6*D6</f></c>');
    expect(xml).not.toContain('C7*D7');
  });

  it('either row can take the new key', async () => {
    const { rows } = await patched({ keepBoth: { aKey: 'INV-4-A', bKey: 'INV-4' } });
    expect(rows.slice(3).map((r) => [r.key, r.customer])).toEqual([
      ['INV-4-A', 'Delta (Ravi)'],
      ['INV-4', 'Delta (Priya)'],
    ]);
  });

  it('the impact preview counts what was kept (totals extended to the new rows)', () => {
    const total = (choice: ConflictResolution): number | 'excel' | undefined => {
      const cs = resolveMerge(base, plan, resolutions(choice), { extendTotals: true });
      return previewImpact(base, cs).find((r) => r.label.toLowerCase().includes('total'))?.after;
    };
    expect(total('A')).toBe(600 + 500);
    expect(total('B')).toBe(600 + 700);
    expect(total({ keepBoth: { aKey: 'INV-4', bKey: 'INV-4-B' } })).toBe(600 + 500 + 700);
  });

  it('totals are extended over both kept rows', async () => {
    const { xml } = await patched({ keepBoth: { aKey: 'INV-4', bKey: 'INV-4-B' } }, true);
    expect(xml).toContain('<f>SUM(Sales!E2:E6)</f>');
    expect(xml).toContain('<f>COUNT(Sales!E2:E6)</f>');
    // …and left alone when the user does not opt in (the totals then miss the new rows).
    const off = await patched({ keepBoth: { aKey: 'INV-4', bKey: 'INV-4-B' } }, false);
    expect(off.xml).toContain('<f>SUM(Sales!E2:E4)</f>');
  });

  describe('merge log', () => {
    const rowsFor = (choice: ConflictResolution) => buildMergeLog(plan, resolutions(choice), LABELS);

    it('records the kept row and who it came from', () => {
      const [row] = rowsFor('B');
      expect(row).toMatchObject({ key: 'INV-4', column: '(new row)', source: 'Priya', decision: 'resolved: B' });
      expect(row!.note).toMatch(/add\/add conflict · inserted after INV-3/);
    });

    it('records both rows, and the key a row was renamed from', () => {
      const rows = rowsFor({ keepBoth: { aKey: 'INV-4', bKey: 'INV-4-B' } });
      expect(rows.map((r) => [r.key, r.source, r.decision])).toEqual([
        ['INV-4', 'Ravi', 'resolved: keep both'],
        ['INV-4-B', 'Priya', 'resolved: keep both'],
      ]);
      expect(rows[1]!.note).toMatch(/was INV-4 in Priya/);
      expect(rows[0]!.note).not.toMatch(/was /);
    });

    it('matches what the patch actually applied', async () => {
      const { out } = await patched({ keepBoth: { aKey: 'INV-4', bKey: 'INV-4-B' } });
      expect(out.applied.map((r) => r.key)).toEqual(['INV-4', 'INV-4-B']);
    });
  });

  describe('rejects answers it cannot apply (MERGE_INVALID_RESOLUTION)', () => {
    const fails = (choice: ConflictResolution): string => {
      try {
        resolveMerge(base, plan, resolutions(choice), { extendTotals: false });
      } catch (e) {
        expect(isSheetDiffError(e) && e.code).toBe('MERGE_INVALID_RESOLUTION');
        return (e as Error).message;
      }
      throw new Error('expected resolveMerge to throw');
    };

    it('a key that clashes with a row in the Original', () => {
      expect(fails({ keepBoth: { aKey: 'INV-4', bKey: 'INV-2' } })).toMatch(/"INV-2" is already used/);
    });

    it('two identical keys', () => {
      expect(fails({ keepBoth: { aKey: 'INV-4', bKey: 'INV-4' } })).toMatch(/two different keys/);
      expect(fails({ keepBoth: { aKey: ' INV-4 ', bKey: 'INV-4' } })).toMatch(/two different keys/);
    });

    it('an empty key', () => {
      expect(fails({ keepBoth: { aKey: 'INV-4', bKey: '   ' } })).toMatch(/needs a key for each/);
    });

    it("a bare 'both' (the old, key-less form) — explains what to send instead", () => {
      expect(fails('both')).toMatch(/not a valid answer for the ADD_ADD conflict on INV-4.*keepBoth/);
    });

    it('answers that belong to other conflict types', () => {
      expect(fails('delete')).toMatch(/not a valid answer/);
      expect(fails('base')).toMatch(/not a valid answer/);
      expect(fails({ typed: 5 })).toMatch(/does not apply/);
    });

    it('still reports an unanswered conflict as unresolved, not invalid', () => {
      expect(() => resolveMerge(base, plan, { conflicts: {} }, { extendTotals: false })).toThrow(/Resolve 1 conflict/);
    });
  });
});

/** Copy 1 adds between INV-1 and INV-2; Copy 2 adds at the end — different anchors. */
describe('ADD_ADD — the copies put the row in different places', () => {
  it('each kept row goes where its own copy put it', async () => {
    const base = await load(workbook(ORIGINAL), 'orig.xlsx', true);
    const a = await load(
      workbook([
        sale(2, 'INV-1', 'Alpha', 2),
        sale(3, 'INV-4', 'Delta (Ravi)', 5),
        sale(4, 'INV-2', 'Beta', 3),
        sale(5, 'INV-3', 'Gamma', 1),
      ], 5),
      'ravi.xlsx',
    );
    const b = await load(workbook([...ORIGINAL, sale(5, 'INV-4', 'Delta (Priya)', 7)]), 'priya.xlsx');
    const plan = planMerge(base, a, b, { labels: LABELS });
    const c = plan.conflicts[0]!;
    expect([c.type, c.afterKey, c.bAfterKey]).toEqual(['ADD_ADD', 'INV-1', 'INV-3']);

    const res: Resolutions = { conflicts: { [c.id]: { keepBoth: { aKey: 'INV-4', bKey: 'INV-5' } } } };
    const out = await applyMergePatch(base, resolveMerge(base, plan, res, { extendTotals: true }), {
      sourceLabels: LABELS,
      log: buildMergeLog(plan, res, LABELS),
    });
    const wb = await readWorkbook(out.bytes, { fileName: 'merged.xlsx' });
    const sales = wb.sheets.find((s) => s.name === 'Sales')!;
    const keys = Array.from({ length: sales.rows - 1 }, (_, i) => getCell(sales, wb.pool, i + 1, 0).text).filter(Boolean);
    expect(keys).toEqual(['INV-1', 'INV-4', 'INV-2', 'INV-3', 'INV-5']);
  });
});

/** Pure checks on the row-building rules (no workbook needed). */
describe('addAddInserts / assertChoiceFits', () => {
  const conflict = (over: Partial<Conflict> = {}): Conflict => ({
    id: 'ADD_ADD:S:K',
    type: 'ADD_ADD',
    sheet: 'S',
    key: 'K',
    aCells: [{ column: 'Name', value: 'a' }],
    bCells: [{ column: 'Name', value: 'b' }],
    afterKey: null,
    bAfterKey: 'X',
    keyColumns: ['Name'],
    ...over,
  });

  it('a numeric key stays a number when the new key is numeric, and becomes text otherwise', () => {
    const c = conflict({ key: '1031', bCells: [{ column: 'No', value: 1031 }], keyColumns: ['No'] });
    const [, b1] = addAddInserts(c, { keepBoth: { aKey: '1031', bKey: '1032' } }, new Set());
    expect(b1!.cells).toEqual([{ column: 'No', value: 1032 }]);
    const [, b2] = addAddInserts(c, { keepBoth: { aKey: '1031', bKey: '1031-2' } }, new Set());
    expect(b2!.cells).toEqual([{ column: 'No', value: '1031-2' }]);
  });

  it('a composite key is rewritten part by part, split on " / "', () => {
    const c = conflict({
      key: '45000 / R9',
      keyColumns: ['Date', 'Ref'],
      bCells: [
        { column: 'Date', value: 45000 },
        { column: 'Ref', value: 'R9' },
        { column: 'Amount', value: 10 },
      ],
    });
    const [, b] = addAddInserts(c, { keepBoth: { aKey: '45000 / R9', bKey: '45001 / R10' } }, new Set());
    expect(b!.key).toBe('45001 / R10');
    expect(b!.cells).toEqual([
      { column: 'Date', value: 45001 },
      { column: 'Ref', value: 'R10' },
      { column: 'Amount', value: 10 },
    ]);
    expect(() => addAddInserts(c, { keepBoth: { aKey: '45000 / R9', bKey: 'oops' } }, new Set())).toThrow(/2 parts/);
  });

  it("a formula in the key cell is replaced by the plain key; other cells are untouched", () => {
    const c = conflict({ bCells: [{ column: 'Name', formula: 'A1&"x"' }, { column: 'Qty', value: 3 }] });
    const [, b] = addAddInserts(c, { keepBoth: { aKey: 'K', bKey: 'K2' } }, new Set());
    expect(b!.cells).toEqual([{ column: 'Name', value: 'K2' }, { column: 'Qty', value: 3 }]);
  });

  it("each side keeps its own anchor and source row; 'A' and 'B' pick one side", () => {
    const c = conflict({ aSourceRow: 4, bSourceRow: 9 });
    const [a, b] = addAddInserts(c, { keepBoth: { aKey: 'K', bKey: 'K2' } }, new Set());
    expect([a!.afterKey, a!.sourceRow, a!.source]).toEqual([null, 4, 'A']);
    expect([b!.afterKey, b!.sourceRow, b!.source]).toEqual(['X', 9, 'B']);
    const [onlyB] = addAddInserts(c, 'B', new Set());
    expect([onlyB!.key, onlyB!.afterKey, onlyB!.source]).toEqual(['K', 'X', 'B']);
  });

  it('claims the keys it uses, so two conflicts cannot end up with the same key', () => {
    const used = new Set<string>();
    addAddInserts(conflict(), { keepBoth: { aKey: 'K', bKey: 'K2' } }, used);
    expect([...used].sort()).toEqual(['K', 'K2']);
    expect(() => addAddInserts(conflict({ key: 'Z' }), { keepBoth: { aKey: 'Z', bKey: 'K2' } }, used)).toThrow(
      /"K2" is already used/,
    );
  });

  it('rejects a rename on a sheet whose key columns are unknown', () => {
    const c = conflict();
    delete c.keyColumns;
    expect(() => addAddInserts(c, { keepBoth: { aKey: 'K', bKey: 'K2' } }, new Set())).toThrow(/key columns are unknown/);
  });

  it('assertChoiceFits allows exactly the documented answers per type', () => {
    const t = (type: Conflict['type'], choice: ConflictResolution): boolean => {
      try {
        assertChoiceFits({ id: 'x', type, sheet: 'S', key: 'K' }, choice);
        return true;
      } catch {
        return false;
      }
    };
    for (const ok of ['A', 'B', 'base', { typed: 1 }] as const) expect(t('CELL', ok)).toBe(true);
    for (const ok of ['A', 'B', 'base', 'both'] as const) expect(t('RELATED_EDITS', ok)).toBe(true);
    for (const ok of ['delete', 'keepEdits', 'base'] as const) expect(t('DELETE_EDIT', ok)).toBe(true);
    for (const ok of ['A', 'B', { keepBoth: { aKey: 'a', bKey: 'b' } }] as const) expect(t('ADD_ADD', ok)).toBe(true);

    expect(t('CELL', 'delete')).toBe(false);
    expect(t('CELL', 'both')).toBe(false);
    expect(t('DELETE_EDIT', 'A')).toBe(false);
    expect(t('RELATED_EDITS', { typed: 1 })).toBe(false);
    expect(t('ADD_ADD', 'base')).toBe(false);
    expect(t('ADD_ADD', 'both')).toBe(false);
  });
});
