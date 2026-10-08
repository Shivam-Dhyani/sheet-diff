/** Criteria parsing and numeric coercion for the evaluator (TDD §11.4). */

export type CellScalar = number | string | boolean | { err: string } | null;

export function isErr(v: unknown): v is { err: string } {
  return typeof v === 'object' && v !== null && 'err' in v;
}

/** Coerce a scalar to a number for arithmetic; null→0; returns null when not numeric. */
export function toNumber(v: CellScalar): number | null {
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return 0;
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Only count values that are genuinely numeric (not coerced text). */
export function numericOnly(v: CellScalar): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

const CRITERIA_RE = /^(<=|>=|<>|=|<|>)?(.*)$/s;

/** Build a predicate from an Excel criteria string ("≥100", "<>", "a*", …). */
export function makeCriteria(criteria: CellScalar): (v: CellScalar) => boolean {
  if (criteria === null) return (v) => v === null || v === '';
  const raw = typeof criteria === 'string' ? criteria : String(criteria);
  const m = CRITERIA_RE.exec(raw)!;
  const op = m[1] ?? '=';
  const operand = m[2] ?? '';

  const operandNum = Number(operand);
  const operandIsNum = operand.trim() !== '' && Number.isFinite(operandNum);

  if (op === '=' || op === undefined) {
    if (/[*?]/.test(operand)) {
      const re = wildcardToRegExp(operand);
      return (v) => re.test(scalarToString(v));
    }
    return (v) => looseEqual(v, operand, operandIsNum, operandNum);
  }
  if (op === '<>') {
    if (/[*?]/.test(operand)) {
      const re = wildcardToRegExp(operand);
      return (v) => !re.test(scalarToString(v));
    }
    return (v) => !looseEqual(v, operand, operandIsNum, operandNum);
  }
  // relational — numeric when operand is numeric, else string compare
  return (v) => {
    if (operandIsNum) {
      const n = numericOnly(v);
      if (n === null) return false;
      return relate(op, n, operandNum);
    }
    return relate(op, scalarToString(v).toLowerCase(), operand.toLowerCase());
  };
}

function looseEqual(v: CellScalar, operand: string, isNum: boolean, num: number): boolean {
  if (isNum) {
    const n = numericOnly(v);
    return n !== null && n === num;
  }
  return scalarToString(v).toLowerCase() === operand.toLowerCase();
}

function relate<T extends number | string>(op: string, a: T, b: T): boolean {
  switch (op) {
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    case '>=':
      return a >= b;
    default:
      return a === b;
  }
}

export function scalarToString(v: CellScalar): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (isErr(v)) return v.err;
  return String(v);
}

function wildcardToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '~') {
      const nxt = pattern[i + 1];
      if (nxt === '*' || nxt === '?' || nxt === '~') {
        out += escapeRe(nxt);
        i++;
        continue;
      }
      out += '~';
    } else if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += escapeRe(ch);
  }
  return new RegExp(out + '$', 'i');
}

function escapeRe(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
