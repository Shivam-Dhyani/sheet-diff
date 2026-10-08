import { ROUND, ROUNDUP, ROUNDDOWN, INT, ABS } from '@formulajs/formulajs';
import { parseFormula, type Node } from './parser.js';
import type { Ref } from './refs.js';
import {
  type CellScalar,
  isErr,
  toNumber,
  numericOnly,
  makeCriteria,
  scalarToString,
} from './functions.js';

/** A cell value provider for evaluation (IR or a merged overlay). */
export interface EvalContext {
  defaultSheet: string;
  getCell(sheet: string, r: number, c: number): CellScalar;
  rowCount(sheet: string): number;
  colCount(sheet: string): number;
  sheetExists(sheet: string): boolean;
}

interface RangeVal {
  kind: 'range';
  sheet: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}
const UNKNOWN = Symbol('unknown');
type Unknown = typeof UNKNOWN;
export type EvalValue = CellScalar | RangeVal | Unknown;

export function isUnknown(v: unknown): v is Unknown {
  return v === UNKNOWN;
}
function isRange(v: EvalValue): v is RangeVal {
  return typeof v === 'object' && v !== null && !isErr(v) && 'kind' in v && v.kind === 'range';
}

const ERR = (e: string): { err: string } => ({ err: e });

/** Evaluate a formula (without leading `=`) against a context. */
export function evaluateFormula(formula: string, ctx: EvalContext): EvalValue {
  const ast = parseFormula(formula);
  return new Evaluator(ctx).eval(ast, new Set());
}

class Evaluator {
  constructor(private readonly ctx: EvalContext) {}

  eval(node: Node, stack: Set<string>): EvalValue {
    switch (node.type) {
      case 'number':
        return node.value;
      case 'string':
        return node.value;
      case 'boolean':
        return node.value;
      case 'error':
        return ERR(node.value);
      case 'name':
      case 'opaque':
        return UNKNOWN;
      case 'ref':
        return this.evalRef(node.ref);
      case 'unary':
        return this.evalUnary(node.op, this.eval(node.operand, stack));
      case 'postfix': {
        const v = this.eval(node.operand, stack);
        if (node.op === '%') {
          const n = this.num(v);
          return n === null ? ERR('#VALUE!') : n / 100;
        }
        return UNKNOWN;
      }
      case 'binary':
        return this.evalBinary(node, stack);
      case 'call':
        return this.evalCall(node.name, node.args, stack);
    }
  }

  private evalRef(ref: Ref): EvalValue {
    const sheet = ref.sheet ?? this.ctx.defaultSheet;
    if (!this.ctx.sheetExists(sheet)) return UNKNOWN;
    if (ref.kind === 'cell') return this.ctx.getCell(sheet, ref.r1, ref.c1);
    // materialize bounds for whole col/row
    const r1 = ref.r1 < 0 ? 0 : ref.r1;
    const r2 = ref.r2 < 0 ? this.ctx.rowCount(sheet) - 1 : ref.r2;
    const c1 = ref.c1 < 0 ? 0 : ref.c1;
    const c2 = ref.c2 < 0 ? this.ctx.colCount(sheet) - 1 : ref.c2;
    return { kind: 'range', sheet, r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
  }

  private materialize(range: RangeVal): CellScalar[] {
    const out: CellScalar[] = [];
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c <= range.c2; c++) {
        out.push(this.ctx.getCell(range.sheet, r, c));
      }
    }
    return out;
  }

  private num(v: EvalValue): number | null {
    if (isUnknown(v) || isRange(v)) return null;
    if (isErr(v)) return null;
    return toNumber(v);
  }

  private evalUnary(op: string, v: EvalValue): EvalValue {
    if (isUnknown(v)) return UNKNOWN;
    if (isErr(v)) return v;
    const n = this.num(v);
    if (n === null) return ERR('#VALUE!');
    return op === '-' ? -n : n;
  }

  private evalBinary(node: Extract<Node, { type: 'binary' }>, stack: Set<string>): EvalValue {
    if (node.op === ':') return UNKNOWN; // dynamic range operator — unsupported
    const l = this.eval(node.left, stack);
    const r = this.eval(node.right, stack);
    if (isUnknown(l) || isUnknown(r)) return UNKNOWN;
    if (isErr(l)) return l;
    if (isErr(r)) return r;

    if (node.op === '&') return scalarToString(scalarOf(l)) + scalarToString(scalarOf(r));

    if (['=', '<>', '<', '>', '<=', '>='].includes(node.op)) {
      return this.compare(node.op, scalarOf(l), scalarOf(r));
    }

    const a = this.num(l);
    const b = this.num(r);
    if (a === null || b === null) return ERR('#VALUE!');
    switch (node.op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return b === 0 ? ERR('#DIV/0!') : a / b;
      case '^':
        return Math.pow(a, b);
      default:
        return UNKNOWN;
    }
  }

  private compare(op: string, a: CellScalar, b: CellScalar): boolean {
    const an = numericOnly(a);
    const bn = numericOnly(b);
    let cmp: number;
    if (an !== null && bn !== null) cmp = an < bn ? -1 : an > bn ? 1 : 0;
    else {
      const as = scalarToString(a).toLowerCase();
      const bs = scalarToString(b).toLowerCase();
      cmp = as < bs ? -1 : as > bs ? 1 : 0;
    }
    switch (op) {
      case '=':
        return cmp === 0;
      case '<>':
        return cmp !== 0;
      case '<':
        return cmp < 0;
      case '>':
        return cmp > 0;
      case '<=':
        return cmp <= 0;
      case '>=':
        return cmp >= 0;
      default:
        return false;
    }
  }

  /** Flatten args into scalars, materializing ranges; returns UNKNOWN if any arg is unknown. */
  private collectNumbers(args: Node[], stack: Set<string>): number[] | Unknown {
    const nums: number[] = [];
    for (const a of args) {
      const v = this.eval(a, stack);
      if (isUnknown(v)) return UNKNOWN;
      if (isRange(v)) {
        for (const cell of this.materialize(v)) {
          const n = numericOnly(cell);
          if (n !== null) nums.push(n);
        }
      } else if (!isErr(v)) {
        const n = numericOnly(v);
        if (n !== null) nums.push(n);
      }
    }
    return nums;
  }

  private evalCall(nameRaw: string, args: Node[], stack: Set<string>): EvalValue {
    const name = nameRaw.replace(/_xlfn\.|_xlws\./gi, '').toUpperCase();
    switch (name) {
      case 'SUM': {
        const ns = this.collectNumbers(args, stack);
        return isUnknown(ns) ? UNKNOWN : ns.reduce((a, b) => a + b, 0);
      }
      case 'AVERAGE': {
        const ns = this.collectNumbers(args, stack);
        if (isUnknown(ns)) return UNKNOWN;
        return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : ERR('#DIV/0!');
      }
      case 'MIN': {
        const ns = this.collectNumbers(args, stack);
        return isUnknown(ns) ? UNKNOWN : ns.length ? Math.min(...ns) : 0;
      }
      case 'MAX': {
        const ns = this.collectNumbers(args, stack);
        return isUnknown(ns) ? UNKNOWN : ns.length ? Math.max(...ns) : 0;
      }
      case 'COUNT': {
        const flat = this.flatten(args, stack);
        if (isUnknown(flat)) return UNKNOWN;
        return flat.filter((v) => numericOnly(v) !== null).length;
      }
      case 'COUNTA': {
        const flat = this.flatten(args, stack);
        if (isUnknown(flat)) return UNKNOWN;
        return flat.filter((v) => v !== null && v !== '').length;
      }
      case 'COUNTBLANK': {
        const flat = this.flatten(args, stack);
        if (isUnknown(flat)) return UNKNOWN;
        return flat.filter((v) => v === null || v === '').length;
      }
      case 'ROUND':
      case 'ROUNDUP':
      case 'ROUNDDOWN':
      case 'INT':
      case 'ABS':
        return this.scalarMath(name, args, stack);
      case 'IF':
        return this.evalIf(args, stack);
      case 'IFERROR': {
        if (args.length < 2) return ERR('#VALUE!');
        const v = this.eval(args[0]!, stack);
        if (isUnknown(v)) return UNKNOWN;
        return isErr(v) ? this.eval(args[1]!, stack) : v;
      }
      case 'AND':
      case 'OR':
      case 'NOT':
        return this.evalLogical(name, args, stack);
      case 'SUMIF':
        return this.evalSumIf(args, stack, false);
      case 'SUMIFS':
        return this.evalSumIfs(args, stack, 'sum');
      case 'COUNTIF':
        return this.evalCountIf(args, stack);
      case 'COUNTIFS':
        return this.evalSumIfs(args, stack, 'count');
      case 'AVERAGEIF':
        return this.evalSumIf(args, stack, true);
      case 'AVERAGEIFS':
        return this.evalSumIfs(args, stack, 'avg');
      case 'SUBTOTAL':
        return this.evalSubtotal(args, stack);
      case 'SUMPRODUCT':
        return this.evalSumProduct(args, stack);
      default:
        return UNKNOWN;
    }
  }

  private flatten(args: Node[], stack: Set<string>): CellScalar[] | Unknown {
    const out: CellScalar[] = [];
    for (const a of args) {
      const v = this.eval(a, stack);
      if (isUnknown(v)) return UNKNOWN;
      if (isRange(v)) out.push(...this.materialize(v));
      else if (isErr(v)) out.push(v);
      else out.push(v);
    }
    return out;
  }

  private scalarMath(name: string, args: Node[], stack: Set<string>): EvalValue {
    const vals = args.map((a) => this.eval(a, stack));
    if (vals.some(isUnknown)) return UNKNOWN;
    const err = vals.find(isErr);
    if (err) return err;
    const n = this.num(vals[0] ?? null);
    if (n === null) return ERR('#VALUE!');
    const d = vals.length > 1 ? (this.num(vals[1]!) ?? 0) : 0;
    try {
      switch (name) {
        case 'ROUND':
          return Number(ROUND(n, d));
        case 'ROUNDUP':
          return Number(ROUNDUP(n, d));
        case 'ROUNDDOWN':
          return Number(ROUNDDOWN(n, d));
        case 'INT':
          return Number(INT(n));
        case 'ABS':
          return Number(ABS(n));
        default:
          return UNKNOWN;
      }
    } catch {
      return ERR('#VALUE!');
    }
  }

  private truthy(v: EvalValue): boolean | null {
    if (isUnknown(v) || isRange(v) || isErr(v)) return null;
    if (typeof v === 'boolean') return v;
    const n = numericOnly(v);
    if (n !== null) return n !== 0;
    if (typeof v === 'string') {
      if (v.toUpperCase() === 'TRUE') return true;
      if (v.toUpperCase() === 'FALSE') return false;
    }
    return null;
  }

  private evalIf(args: Node[], stack: Set<string>): EvalValue {
    if (args.length < 2) return ERR('#VALUE!');
    const cond = this.eval(args[0]!, stack);
    if (isUnknown(cond)) return UNKNOWN;
    if (isErr(cond)) return cond;
    const t = this.truthy(cond);
    if (t === null) return ERR('#VALUE!');
    if (t) return this.eval(args[1]!, stack);
    return args.length > 2 ? this.eval(args[2]!, stack) : false;
  }

  private evalLogical(name: string, args: Node[], stack: Set<string>): EvalValue {
    const flat = this.flatten(args, stack);
    if (isUnknown(flat)) return UNKNOWN;
    const bools: boolean[] = [];
    for (const v of flat) {
      if (isErr(v)) return v;
      const t = this.truthy(v);
      if (t !== null) bools.push(t);
    }
    if (name === 'NOT') return bools.length ? !bools[0] : ERR('#VALUE!');
    if (name === 'AND') return bools.every(Boolean);
    return bools.some(Boolean);
  }

  private asRange(node: Node, stack: Set<string>): RangeVal | null {
    const v = this.eval(node, stack);
    return isRange(v) ? v : null;
  }

  private evalCountIf(args: Node[], stack: Set<string>): EvalValue {
    if (args.length < 2) return ERR('#VALUE!');
    const range = this.asRange(args[0]!, stack);
    if (!range) return UNKNOWN;
    const crit = this.eval(args[1]!, stack);
    if (isUnknown(crit) || isRange(crit)) return UNKNOWN;
    const pred = makeCriteria(isErr(crit) ? crit.err : crit);
    return this.materialize(range).filter(pred).length;
  }

  private evalSumIf(args: Node[], stack: Set<string>, average: boolean): EvalValue {
    if (args.length < 2) return ERR('#VALUE!');
    const range = this.asRange(args[0]!, stack);
    if (!range) return UNKNOWN;
    const crit = this.eval(args[1]!, stack);
    if (isUnknown(crit) || isRange(crit)) return UNKNOWN;
    const sumRange = args[2] ? this.asRange(args[2]!, stack) : range;
    if (!sumRange) return UNKNOWN;
    const pred = makeCriteria(isErr(crit) ? crit.err : crit);
    const critCells = this.materialize(range);
    const sumCells = this.materialize(sumRange);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < critCells.length; i++) {
      if (!pred(critCells[i]!)) continue;
      const n = numericOnly(sumCells[i] ?? null);
      if (n !== null) {
        sum += n;
        count++;
      }
    }
    if (average) return count ? sum / count : ERR('#DIV/0!');
    return sum;
  }

  private evalSumIfs(args: Node[], stack: Set<string>, mode: 'sum' | 'count' | 'avg'): EvalValue {
    // SUMIFS(sumRange, critRange1, crit1, ...) / COUNTIFS(critRange1, crit1, ...)
    let targetCells: CellScalar[] | null = null;
    let pairStart = 0;
    if (mode === 'sum' || mode === 'avg') {
      const target = this.asRange(args[0]!, stack);
      if (!target) return UNKNOWN;
      targetCells = this.materialize(target);
      pairStart = 1;
    }
    const preds: { cells: CellScalar[]; pred: (v: CellScalar) => boolean }[] = [];
    for (let i = pairStart; i + 1 < args.length; i += 2) {
      const range = this.asRange(args[i]!, stack);
      if (!range) return UNKNOWN;
      const crit = this.eval(args[i + 1]!, stack);
      if (isUnknown(crit) || isRange(crit)) return UNKNOWN;
      preds.push({ cells: this.materialize(range), pred: makeCriteria(isErr(crit) ? crit.err : crit) });
    }
    const len = preds[0]?.cells.length ?? 0;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < len; i++) {
      if (!preds.every((p) => p.pred(p.cells[i] ?? null))) continue;
      count++;
      if (targetCells) {
        const n = numericOnly(targetCells[i] ?? null);
        if (n !== null) sum += n;
      }
    }
    if (mode === 'count') return count;
    if (mode === 'avg') return count ? sum / count : ERR('#DIV/0!');
    return sum;
  }

  private evalSubtotal(args: Node[], stack: Set<string>): EvalValue {
    if (args.length < 2) return ERR('#VALUE!');
    const fnNodeVal = this.eval(args[0]!, stack);
    const fnNum = this.num(fnNodeVal);
    if (fnNum === null) return UNKNOWN;
    const base = ((fnNum % 100) + 100) % 100;
    const rest = args.slice(1);
    switch (base) {
      case 1:
        return this.evalCall('AVERAGE', rest, stack);
      case 2:
        return this.evalCall('COUNT', rest, stack);
      case 3:
        return this.evalCall('COUNTA', rest, stack);
      case 4:
        return this.evalCall('MAX', rest, stack);
      case 5:
        return this.evalCall('MIN', rest, stack);
      case 9:
        return this.evalCall('SUM', rest, stack);
      default:
        return UNKNOWN;
    }
  }

  private evalSumProduct(args: Node[], stack: Set<string>): EvalValue {
    const arrays: number[][] = [];
    for (const a of args) {
      const v = this.eval(a, stack);
      if (isUnknown(v)) return UNKNOWN;
      if (isRange(v)) arrays.push(this.materialize(v).map((c) => numericOnly(c) ?? 0));
      else {
        const n = this.num(v);
        if (n === null) return ERR('#VALUE!');
        arrays.push([n]);
      }
    }
    if (arrays.length === 0) return 0;
    const len = arrays[0]!.length;
    if (!arrays.every((arr) => arr.length === len)) return ERR('#VALUE!');
    let total = 0;
    for (let i = 0; i < len; i++) {
      let prod = 1;
      for (const arr of arrays) prod *= arr[i]!;
      total += prod;
    }
    return total;
  }
}

/** Collapse a non-range eval value to a scalar (ranges → their top-left is not taken here). */
function scalarOf(v: EvalValue): CellScalar {
  if (isUnknown(v)) return null;
  if (typeof v === 'object' && v !== null && 'kind' in v) return null;
  return v;
}
