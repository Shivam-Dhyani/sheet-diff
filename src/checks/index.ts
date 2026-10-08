import { CellKind, type SheetIR, type StringPool, type WorkbookIR } from '../ir/types.js';
import { getCell } from '../ir/sheet.js';
import { cellIndex, rcToA1 } from '../ir/coords.js';
import type { Finding, CompareResult, Severity } from '../types.js';
import type { CompareOptions } from '../options.js';
import type { CheckContext, CheckPair } from './context.js';
import type { TableModel } from '../table/index.js';
import { parseTextDate, serialToYmd, ymdKey, type Ymd } from '../compare/dates.js';
import { parseFormula, type Node } from '../formula/parser.js';
import { translateFormula } from '../formula/translate.js';
import { evaluateFormula, isUnknown } from '../formula/evaluator.js';
import { makeEvalContext } from '../formula/ir-context.js';
import { formatValue, formatINR, findingId } from './messages.js';

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, info: 2 };
const AGG_FUNCS = new Set([
  'SUM',
  'SUMIF',
  'SUMIFS',
  'COUNT',
  'COUNTA',
  'COUNTIF',
  'COUNTIFS',
  'AVERAGE',
  'AVERAGEIF',
  'AVERAGEIFS',
  'MIN',
  'MAX',
  'SUBTOTAL',
  'AGGREGATE',
  'SUMPRODUCT',
]);

interface PairCtx extends CheckPair {
  oldSheet: SheetIR;
  newSheet: SheetIR;
  oldTable: TableModel;
  newTable: TableModel;
}

function isUsable(p: CheckPair): p is PairCtx {
  return Boolean(p.oldSheet && p.newSheet && p.oldTable && p.newTable);
}

function keyAt(sheet: SheetIR, pool: StringPool, cols: number[], r: number): string {
  if (cols.length === 0) return '';
  return cols
    .map((c) => {
      const cell = getCell(sheet, pool, r, c);
      return cell.kind === CellKind.String || cell.kind === CellKind.Error ? cell.text : String(cell.num);
    })
    .join(' / ');
}

/** Run every risk check against a rich context (TDD §8). */
export function runChecksWithContext(ctx: CheckContext): Finding[] {
  const findings: Finding[] = [];
  const usable = ctx.pairs.filter(isUsable);

  for (const p of usable) {
    chk01(p, ctx, findings);
    chk04(p, ctx, findings);
    chk05(p, ctx, findings);
    chk06(p, ctx, findings);
    chk07(p, ctx, findings);
    if (ctx.checkOpts.indiaPack) chk10(p, ctx, findings);
    rowAndCellFindings(p, ctx, findings);
  }

  chk02(ctx, usable, findings);
  chk03(ctx, usable, findings);
  chk09(ctx, findings);

  return sortFindings(findings);
}

/** Public re-run entry (rebuilds nothing; expects a prepared context is unavailable here). */
export function runChecks(
  _result: CompareResult,
  _oldWb: WorkbookIR,
  _newWb: WorkbookIR,
  _opts?: Partial<CompareOptions>,
): Finding[] {
  // The public, context-free re-run lives in compare/index.ts (it rebuilds the
  // context). This export exists so checks/index has a stable name; callers use
  // the compare module's runChecks.
  return [];
}

function sortFindings(findings: Finding[]): Finding[] {
  // BR-C6: High → Medium → Info; within a severity, flagged rows first, then by
  // pair/row/column. We approximate "flagged first" by rule weight.
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      ruleWeight(a) - ruleWeight(b) ||
      (a.pairId ?? '').localeCompare(b.pairId ?? '') ||
      (a.key ?? '').localeCompare(b.key ?? '') ||
      (a.column ?? '').localeCompare(b.column ?? ''),
  );
}

function ruleWeight(f: Finding): number {
  const order = ['CHK-01', 'CHK-02', 'CHK-03', 'CHK-04', 'CHK-05', 'CHK-06', 'CHK-07', 'CHK-10', 'CHK-09'];
  const i = order.indexOf(f.rule);
  return i < 0 ? 100 : i;
}

/* ─────────────────────────── CHK-01 ─────────────────────────── */
function chk01(p: PairCtx, ctx: CheckContext, out: Finding[]): void {
  const evalCtx = makeEvalContext(ctx.newWb, p.newSheet.name);
  for (const ch of p.result.cellChanges) {
    if (ch.kind !== 'formula_overwritten' || !ch.oldFormula) continue;
    let expectedStr = '';
    let diffNote = '';
    try {
      const translated = translateFormula(ch.oldFormula, p.translateCtx!);
      const expected = evaluateFormula(translated, evalCtx);
      if (!isUnknown(expected) && typeof expected === 'number') {
        expectedStr = formatValue(expected, ch.column);
        if (typeof ch.new === 'number' && Math.abs(ch.new - expected) > (ctx.opts.numericTolerance ?? 0.01)) {
          diffNote = `, not ${formatValue(ch.new, ch.column)}`;
        }
      }
    } catch {
      /* evaluator failed → omit expected value */
    }
    const expectedClause = expectedStr ? ` The formula gives ${expectedStr}${diffNote}.` : '';
    out.push({
      id: findingId('CHK-01', p.id, ch.key, ch.column),
      rule: 'CHK-01',
      severity: 'high',
      pairId: p.id,
      key: ch.key,
      column: ch.column,
      cells: ch.newCell ? [ch.newCell.ref] : [],
      title: 'Formula replaced by a typed number',
      message: `Someone typed ${formatValue(ch.new, ch.column)} over the formula in ${ch.column} for ${ch.key}.${expectedClause} This cell will no longer update when other values change.`,
      data: { oldFormula: ch.oldFormula, typed: ch.new, expected: expectedStr || undefined },
    });
  }
}

/* ─────────────────────────── CHK-02 ─────────────────────────── */
function chk02(ctx: CheckContext, pairs: PairCtx[], out: Finding[]): void {
  const tableByNewSheet = new Map<string, { table: TableModel; pair: PairCtx }>();
  for (const p of pairs) tableByNewSheet.set(p.newSheet.name, { table: p.newTable, pair: p });

  interface Hit {
    sheet: string;
    excludedKeys: string[];
    cells: string[];
    column: string;
    impact: number | null;
  }
  const grouped = new Map<string, Hit>();

  for (const sheet of ctx.newWb.sheets) {
    for (const [idx, fId] of sheet.formula) {
      const r = Math.floor(idx / sheet.cols);
      const c = idx % sheet.cols;
      const formula = ctx.newWb.pool.get(fId);
      if (!formula) continue;
      const ast = parseFormula(formula);
      walk(ast, (node) => {
        if (node.type !== 'call' || !AGG_FUNCS.has(node.name.replace(/_xlfn\.|_xlws\./gi, '').toUpperCase())) return;
        for (const arg of node.args) {
          if (arg.type !== 'ref' || (arg.ref.kind !== 'range' && arg.ref.kind !== 'cols')) continue;
          const target = arg.ref.sheet ?? sheet.name;
          const t = tableByNewSheet.get(target);
          if (!t) continue;
          const tbl = t.table;
          const f = tbl.dataStart;
          const l = tbl.dataEnd;
          const a = arg.ref.kind === 'cols' ? f : arg.ref.r1;
          const b = arg.ref.kind === 'cols' ? l : arg.ref.r2;
          // column(s) inside the table?
          const colInTable = tbl.columns.some((col) => col.index >= arg.ref.c1 && col.index <= arg.ref.c2);
          if (!colInTable) continue;
          if (!(a <= f + 1 && f <= b && b < l)) continue;
          const coverage = (b - Math.max(a, f) + 1) / (l - f + 1);
          if (coverage < 0.5) continue;
          // excluded rows (b, l]
          const excludedKeys: string[] = [];
          let impact = 0;
          let impactKnown = true;
          for (let er = b + 1; er <= l; er++) {
            excludedKeys.push(keyAt(t.pair.newSheet, ctx.newWb.pool, t.pair.newKeyCols ?? [], er) || `row ${er + 1}`);
            const val = getCell(t.pair.newSheet, ctx.newWb.pool, er, arg.ref.c1);
            if (val.kind === CellKind.Number) impact += val.num;
            else impactKnown = false;
          }
          const gKey = `${sheet.name}|${excludedKeys.join(',')}`;
          const existing = grouped.get(gKey);
          const cellRef = rcToA1(r, c);
          if (existing) {
            if (!existing.cells.includes(cellRef)) existing.cells.push(cellRef);
          } else {
            grouped.set(gKey, {
              sheet: sheet.name,
              excludedKeys,
              cells: [cellRef],
              column: t.table.columns[0]?.header ?? '',
              impact: impactKnown ? impact : null,
            });
          }
        }
      });
    }
  }

  for (const hit of grouped.values()) {
    const impactLine =
      hit.impact !== null
        ? `This understates the total by ${formatINR(Math.abs(hit.impact))}.`
        : 'The total may be understated.';
    out.push({
      id: findingId('CHK-02', hit.sheet, hit.excludedKeys.join(',')),
      rule: 'CHK-02',
      severity: 'high',
      cells: hit.cells,
      title: `Totals don't include ${hit.excludedKeys.length} row(s)`,
      message: `${hit.excludedKeys.join(', ')} ${hit.excludedKeys.length === 1 ? 'is' : 'are'} below the range used by ${hit.cells.length} total formula(s) on ${hit.sheet} (${hit.cells.join(', ')}). ${impactLine}`,
      data: { excludedKeys: hit.excludedKeys, cells: hit.cells, impact: hit.impact },
    });
  }
}

/* ─────────────────────────── CHK-03 ─────────────────────────── */
function chk03(ctx: CheckContext, pairs: PairCtx[], out: Finding[]): void {
  // Collect all string cells in the new workbook, excluding key columns.
  const keyColsByNewSheet = new Map<string, Set<number>>();
  for (const p of pairs) keyColsByNewSheet.set(p.newSheet.name, new Set(p.newKeyCols ?? []));

  for (const p of pairs) {
    const removedKeys = (p.removed ?? []).map((r) => ({
      r,
      key: keyAt(p.oldSheet, ctx.oldWb.pool, p.oldKeyCols ?? [], r),
    }));
    for (const { key } of removedKeys) {
      const norm = key.trim();
      if (norm.length < 4) continue;
      if (!/[A-Za-z]/.test(norm) && (norm.match(/\d/g)?.length ?? 0) < 4) continue;
      const locations = findReferences(ctx.newWb, norm, keyColsByNewSheet);
      if (locations.length === 0) continue;
      out.push({
        id: findingId('CHK-03', p.id, norm),
        rule: 'CHK-03',
        severity: 'high',
        pairId: p.id,
        key: norm,
        cells: locations,
        title: 'Deleted, but referenced elsewhere',
        message: `${norm} was removed from ${p.newSheet.name} but still appears in ${locations.join(', ')}. If both are filed, the same item may be counted or reduced twice.`,
        data: { locations },
      });
    }
  }
}

function findReferences(
  wb: WorkbookIR,
  needle: string,
  keyColsByNewSheet: Map<string, Set<number>>,
): string[] {
  const out: string[] = [];
  const target = needle.toLowerCase();
  for (const sheet of wb.sheets) {
    const keyCols = keyColsByNewSheet.get(sheet.name) ?? new Set<number>();
    for (let r = 0; r < sheet.rows; r++) {
      for (let c = 0; c < sheet.cols; c++) {
        if (keyCols.has(c)) continue;
        const i = cellIndex(r, c, sheet.cols);
        if (sheet.kind[i] !== CellKind.String) continue;
        const text = wb.pool.get(sheet.str[i]!).trim().toLowerCase();
        if (text === target) out.push(`${sheet.name}!${rcToA1(r, c)}`);
      }
    }
  }
  return out.slice(0, 20);
}

/* ─────────────────────────── CHK-04 ─────────────────────────── */
function chk04(p: PairCtx, ctx: CheckContext, out: Finding[]): void {
  const dateCol = findDateColumn(p.newSheet, ctx.newWb.pool, p.newTable, ctx.opts);
  if (dateCol < 0) return;
  const period = dominantMonth(p.newSheet, ctx.newWb.pool, p.newTable, dateCol, ctx.opts);
  if (!period) return;

  const changedRows = new Set<number>();
  for (const ch of p.result.cellChanges) if (ch.newCell) changedRows.add(ch.newCell.r);
  for (const r of p.added ?? []) changedRows.add(r);

  for (const r of [...changedRows].sort((a, b) => a - b)) {
    const ymd = cellYmd(p.newSheet, ctx.newWb.pool, r, dateCol, ctx.opts);
    if (!ymd) continue;
    if (ymd.y === period.y && ymd.m === period.m) continue;
    const key = keyAt(p.newSheet, ctx.newWb.pool, p.newKeyCols ?? [], r) || `row ${r + 1}`;
    const periodName = monthName(period);
    out.push({
      id: findingId('CHK-04', p.id, key),
      rule: 'CHK-04',
      severity: 'high',
      pairId: p.id,
      key,
      cells: [rcToA1(r, dateCol)],
      title: `Date moved outside ${periodName}`,
      message: `${key} is now dated ${ymdKey(ymd)} in a ${periodName} sheet. It may belong to another period, or the date is a typo.`,
      data: { date: ymdKey(ymd), period: `${period.y}-${String(period.m).padStart(2, '0')}` },
    });
  }
}

function findDateColumn(sheet: SheetIR, pool: StringPool, table: TableModel, opts: CompareOptions): number {
  for (const col of table.columns) {
    let nonEmpty = 0;
    let dates = 0;
    for (let r = table.dataStart; r <= table.dataEnd; r++) {
      const cell = getCell(sheet, pool, r, col.index);
      if (cell.kind === CellKind.Empty) continue;
      nonEmpty++;
      if (cell.kind === CellKind.DateSerial) dates++;
      else if (cell.kind === CellKind.String && parseTextDate(cell.text, opts.dateOrder)) dates++;
    }
    if (nonEmpty > 0 && dates / nonEmpty >= 0.9) return col.index;
  }
  return -1;
}

function cellYmd(sheet: SheetIR, pool: StringPool, r: number, c: number, opts: CompareOptions): Ymd | null {
  const cell = getCell(sheet, pool, r, c);
  if (cell.kind === CellKind.DateSerial) return serialToYmd(cell.num, false);
  if (cell.kind === CellKind.String) return parseTextDate(cell.text, opts.dateOrder);
  return null;
}

function dominantMonth(sheet: SheetIR, pool: StringPool, table: TableModel, col: number, opts: CompareOptions): Ymd | null {
  const counts = new Map<string, { n: number; ymd: Ymd }>();
  let total = 0;
  for (let r = table.dataStart; r <= table.dataEnd; r++) {
    const ymd = cellYmd(sheet, pool, r, col, opts);
    if (!ymd) continue;
    total++;
    const k = `${ymd.y}-${ymd.m}`;
    const e = counts.get(k);
    if (e) e.n++;
    else counts.set(k, { n: 1, ymd: { ...ymd, d: 1 } });
  }
  if (total === 0) return null;
  for (const { n, ymd } of counts.values()) {
    if (n / total >= 0.8) return ymd;
  }
  return null;
}

function monthName(ymd: Ymd): string {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[ymd.m - 1]}-${ymd.y}`;
}

/* ─────────────────────────── CHK-05 ─────────────────────────── */
function chk05(p: PairCtx, ctx: CheckContext, out: Finding[]): void {
  const exclude = new Set(p.newKeyCols ?? []);
  const idCol = findIdColumn(p.newSheet, ctx.newWb.pool, p.newTable, exclude);
  const nameCol = findNameColumn(p.newSheet, ctx.newWb.pool, p.newTable, idCol, exclude);
  if (idCol < 0 || nameCol < 0) return;

  const oldMap = nameToIds(p.oldSheet, ctx.oldWb.pool, p.oldTable, nameCol, idCol);
  const newMap = nameToIds(p.newSheet, ctx.newWb.pool, p.newTable, nameCol, idCol);

  // old dependency must hold for ≥95% of names with ≥2 rows
  let multi = 0;
  let consistent = 0;
  for (const ids of oldMap.values()) {
    if (ids.total < 2) continue;
    multi++;
    if (ids.distinct.size === 1) consistent++;
  }
  if (multi > 0 && consistent / multi < 0.95) return;

  for (const [name, ids] of newMap) {
    const oldIds = oldMap.get(name);
    if (!oldIds || oldIds.distinct.size !== 1 || ids.distinct.size <= 1) continue;
    const oldId = [...oldIds.distinct][0]!;
    for (const { r, id } of ids.rows) {
      if (id === oldId) continue;
      const key = keyAt(p.newSheet, ctx.newWb.pool, p.newKeyCols ?? [], r) || `row ${r + 1}`;
      const idHeader = p.newTable.columns.find((cc) => cc.index === idCol)?.header ?? 'ID';
      out.push({
        id: findingId('CHK-05', p.id, key, name),
        rule: 'CHK-05',
        severity: 'medium',
        pairId: p.id,
        key,
        column: idHeader,
        cells: [rcToA1(r, idCol)],
        title: `${name} now has two ${idHeader}s`,
        message: `${key} uses ${id}, while ${name}'s other rows use ${oldId}. This is probably a typo.`,
        data: { name, newId: id, oldId },
      });
    }
  }
}

const ID_STRONG_RE = /(gstin|pan)/i;
const ID_HEADER_RE = /(id|code|no\.?|number)/i;
const ID_VALUE_RE = /^[A-Z0-9\-/]{6,}$/;

function findIdColumn(
  sheet: SheetIR,
  pool: StringPool,
  table: TableModel,
  exclude: Set<number>,
): number {
  // Prefer a GSTIN/PAN column (the entity identifier CHK-05 is about), then
  // other ID-like headers, then value-based detection. The row key (e.g.
  // "Invoice No") is excluded — it is unique per row and never the entity ID.
  for (const col of table.columns) {
    if (!exclude.has(col.index) && ID_STRONG_RE.test(col.header)) return col.index;
  }
  for (const col of table.columns) {
    if (!exclude.has(col.index) && ID_HEADER_RE.test(col.header)) return col.index;
  }
  for (const col of table.columns) {
    if (exclude.has(col.index)) continue;
    let nonEmpty = 0;
    let idLike = 0;
    for (let r = table.dataStart; r <= table.dataEnd; r++) {
      const cell = getCell(sheet, pool, r, col.index);
      if (cell.kind !== CellKind.String) continue;
      nonEmpty++;
      if (ID_VALUE_RE.test(cell.text.trim())) idLike++;
    }
    if (nonEmpty > 0 && idLike / nonEmpty >= 0.8) return col.index;
  }
  return -1;
}

function findNameColumn(
  sheet: SheetIR,
  pool: StringPool,
  table: TableModel,
  idCol: number,
  exclude: Set<number>,
): number {
  for (const col of table.columns) {
    if (col.index === idCol || exclude.has(col.index)) continue;
    let text = 0;
    let nonEmpty = 0;
    for (let r = table.dataStart; r <= table.dataEnd; r++) {
      const cell = getCell(sheet, pool, r, col.index);
      if (cell.kind === CellKind.Empty) continue;
      nonEmpty++;
      if (cell.kind === CellKind.String && !ID_VALUE_RE.test(cell.text.trim())) text++;
    }
    if (nonEmpty > 0 && text / nonEmpty >= 0.8) return col.index;
  }
  return -1;
}

function nameToIds(
  sheet: SheetIR,
  pool: StringPool,
  table: TableModel,
  nameCol: number,
  idCol: number,
): Map<string, { distinct: Set<string>; total: number; rows: { r: number; id: string }[] }> {
  const map = new Map<string, { distinct: Set<string>; total: number; rows: { r: number; id: string }[] }>();
  for (let r = table.dataStart; r <= table.dataEnd; r++) {
    const name = getCell(sheet, pool, r, nameCol);
    const id = getCell(sheet, pool, r, idCol);
    if (name.kind !== CellKind.String || id.kind === CellKind.Empty) continue;
    const idStr = id.kind === CellKind.String ? id.text.trim() : String(id.num);
    const entry = map.get(name.text.trim()) ?? { distinct: new Set<string>(), total: 0, rows: [] };
    entry.distinct.add(idStr);
    entry.total++;
    entry.rows.push({ r, id: idStr });
    map.set(name.text.trim(), entry);
  }
  return map;
}

/* ─────────────────────────── CHK-06 ─────────────────────────── */
function chk06(p: PairCtx, _ctx: CheckContext, out: Finding[]): void {
  for (const ch of p.result.cellChanges) {
    if (!ch.flags.includes('number_as_text')) continue;
    out.push({
      id: findingId('CHK-06', p.id, ch.key, ch.column),
      rule: 'CHK-06',
      severity: 'medium',
      pairId: p.id,
      key: ch.key,
      column: ch.column,
      cells: ch.newCell ? [ch.newCell.ref] : [],
      title: 'Number stored as text',
      message: `'${String(ch.new)}' is stored as text, so totals skip it.`,
      data: { value: ch.new },
    });
  }
}

/* ─────────────────────────── CHK-07 ─────────────────────────── */
function chk07(p: PairCtx, ctx: CheckContext, out: Finding[]): void {
  const newGroups = duplicateGroups(p.newSheet, ctx.newWb.pool, p.newTable, p.newKeyCols ?? []);
  const oldGroups = duplicateGroups(p.oldSheet, ctx.oldWb.pool, p.oldTable, p.oldKeyCols ?? []);
  for (const [key, n] of newGroups) {
    if (oldGroups.has(key)) continue;
    out.push({
      id: findingId('CHK-07', p.id, key),
      rule: 'CHK-07',
      severity: 'medium',
      pairId: p.id,
      key,
      title: 'Duplicate key introduced',
      message: `${key} appears ${n} times.`,
      data: { count: n },
    });
  }
}

function duplicateGroups(sheet: SheetIR, pool: StringPool, table: TableModel, cols: number[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (cols.length === 0) return counts;
  for (let r = table.dataStart; r <= table.dataEnd; r++) {
    const key = keyAt(sheet, pool, cols, r);
    if (key === '') continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [k, n] of [...counts]) if (n < 2) counts.delete(k);
  return counts;
}

/* ─────────────────────────── CHK-09 ─────────────────────────── */
function chk09(ctx: CheckContext, out: Finding[]): void {
  for (const p of ctx.pairs) {
    if (p.status === 'added') {
      out.push(info('CHK-09', p.id, `New sheet: ${p.result.newName}.`, { kind: 'sheet_added' }));
    } else if (p.status === 'removed') {
      out.push(info('CHK-09', p.id, `Removed sheet: ${p.result.oldName}.`, { kind: 'sheet_removed' }));
    } else if (p.status === 'renamed') {
      out.push(
        info('CHK-09', p.id, `Sheet renamed: ${p.result.oldName} → ${p.result.newName}.`, { kind: 'sheet_renamed' }),
      );
    }
    for (const col of p.result.columns) {
      if (col.status === 'added') out.push(info('CHK-09', p.id, `New column: ${col.newName}.`, { kind: 'column_added' }));
      else if (col.status === 'removed')
        out.push(info('CHK-09', p.id, `Removed column: ${col.oldName}.`, { kind: 'column_removed' }));
      else if (col.status === 'renamed')
        out.push(info('CHK-09', p.id, `Column renamed: ${col.oldName} → ${col.newName}.`, { kind: 'column_renamed' }));
    }
    if ((p.moved?.length ?? 0) > 0) {
      out.push(info('CHK-09', p.id, `${p.moved!.length} row(s) moved on ${p.result.newName}.`, { kind: 'rows_moved' }));
    }
  }
}

function info(rule: Finding['rule'], pairId: string, message: string, data: Record<string, unknown>): Finding {
  return {
    id: findingId(rule, pairId, undefined, message),
    rule,
    severity: 'info',
    pairId,
    title: message,
    message,
    data,
  };
}

/* ─────────────────────────── CHK-10 ─────────────────────────── */
const GSTIN_RE = /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

function chk10(p: PairCtx, ctx: CheckContext, out: Finding[]): void {
  const changedRows = new Set<number>();
  for (const ch of p.result.cellChanges) if (ch.newCell) changedRows.add(ch.newCell.r);
  for (const r of p.added ?? []) changedRows.add(r);

  for (const col of p.newTable.columns) {
    const isGstin = /gstin/i.test(col.header);
    const isPan = /\bpan\b/i.test(col.header);
    if (!isGstin && !isPan) continue;
    for (const r of changedRows) {
      const cell = getCell(p.newSheet, ctx.newWb.pool, r, col.index);
      if (cell.kind !== CellKind.String) continue;
      const v = cell.text.trim().toUpperCase();
      const valid = isGstin ? GSTIN_RE.test(v) : PAN_RE.test(v);
      if (valid) continue;
      const key = keyAt(p.newSheet, ctx.newWb.pool, p.newKeyCols ?? [], r) || `row ${r + 1}`;
      out.push({
        id: findingId('CHK-10', p.id, key, col.header),
        rule: 'CHK-10',
        severity: 'medium',
        pairId: p.id,
        key,
        column: col.header,
        cells: [rcToA1(r, col.index)],
        title: `Invalid ${isGstin ? 'GSTIN' : 'PAN'} format`,
        message: `${cell.text} is not a valid ${isGstin ? 'GSTIN' : 'PAN'} format.`,
        data: { value: cell.text },
      });
    }
  }
}

/* ─────────────────── Non-rule findings ─────────────────── */
function rowAndCellFindings(p: PairCtx, ctx: CheckContext, out: Finding[]): void {
  for (const r of p.added ?? []) {
    const key = keyAt(p.newSheet, ctx.newWb.pool, p.newKeyCols ?? [], r) || `row ${r + 1}`;
    out.push({
      id: findingId('ROW_ADDED', p.id, key),
      rule: 'ROW_ADDED',
      severity: 'medium',
      pairId: p.id,
      key,
      title: 'Row added',
      message: `${key} was added.`,
      data: {},
    });
  }
  for (const r of p.removed ?? []) {
    const key = keyAt(p.oldSheet, ctx.oldWb.pool, p.oldKeyCols ?? [], r) || `row ${r + 1}`;
    out.push({
      id: findingId('ROW_REMOVED', p.id, key),
      rule: 'ROW_REMOVED',
      severity: 'medium',
      pairId: p.id,
      key,
      title: 'Row removed',
      message: `${key} was removed.`,
      data: {},
    });
  }
  let recalculated = 0;
  for (const ch of p.result.cellChanges) {
    if (ch.kind === 'recalculated') {
      recalculated++;
      continue;
    }
    if (ch.kind === 'format_changed') continue;
    out.push({
      id: findingId('CELL_EDIT', p.id, ch.key, ch.column),
      rule: 'CELL_EDIT',
      severity: 'medium',
      pairId: p.id,
      key: ch.key,
      column: ch.column,
      cells: ch.newCell ? [ch.newCell.ref] : [],
      title: changeTitle(ch.kind),
      message: `${ch.column} for ${ch.key}: ${formatValue(ch.old, ch.column)} → ${formatValue(ch.new, ch.column)}.`,
      data: { kind: ch.kind },
    });
  }
  if (recalculated > 0) {
    out.push({
      id: findingId('RECALCULATED', p.id),
      rule: 'RECALCULATED',
      severity: 'info',
      pairId: p.id,
      title: `${recalculated} cell(s) updated automatically`,
      message: `${recalculated} formula cell(s) recalculated because their inputs changed. These are not counted as real changes.`,
      data: { count: recalculated },
    });
  }
}

function changeTitle(kind: string): string {
  switch (kind) {
    case 'value_changed':
      return 'Value edited';
    case 'type_changed':
      return 'Type changed';
    case 'formula_changed':
      return 'Formula changed';
    case 'formula_added':
      return 'Formula added';
    default:
      return 'Cell changed';
  }
}

/* ─────────────────── AST walk ─────────────────── */
function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  switch (node.type) {
    case 'unary':
    case 'postfix':
      walk(node.operand, visit);
      break;
    case 'binary':
      walk(node.left, visit);
      walk(node.right, visit);
      break;
    case 'call':
      for (const a of node.args) walk(a, visit);
      break;
    default:
      break;
  }
}
