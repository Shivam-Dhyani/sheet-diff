import { tokenize, type Token } from './tokenizer.js';
import { parseRef, refToString, type Ref } from './refs.js';

/**
 * Translation context (TDD §11.3). Maps old row/col indices to new ones for a
 * given sheet (−1 = deleted → `#REF!`). Row/col counts bound endpoint searches
 * for ranges.
 */
export interface TranslateContext {
  defaultSheet: string;
  rowMap: (sheet: string, oldRow: number) => number;
  colMap: (sheet: string, oldCol: number) => number;
  rowCount: (sheet: string) => number;
  colCount: (sheet: string) => number;
}

const REF_ERR = '#REF!';

function firstSurviving(
  map: (i: number) => number,
  from: number,
  to: number,
): { oldIdx: number; newIdx: number } | null {
  for (let i = from; i <= to; i++) {
    const m = map(i);
    if (m >= 0) return { oldIdx: i, newIdx: m };
  }
  return null;
}

function lastSurviving(
  map: (i: number) => number,
  from: number,
  to: number,
): { oldIdx: number; newIdx: number } | null {
  for (let i = to; i >= from; i--) {
    const m = map(i);
    if (m >= 0) return { oldIdx: i, newIdx: m };
  }
  return null;
}

/** Translate a single parsed ref through the maps; returns null → `#REF!`. */
export function translateRef(ref: Ref, ctx: TranslateContext): Ref | null {
  const sheet = ref.sheet ?? ctx.defaultSheet;
  const rm = (r: number): number => ctx.rowMap(sheet, r);
  const cm = (c: number): number => ctx.colMap(sheet, c);

  if (ref.kind === 'cell') {
    const nr = rm(ref.r1);
    const nc = cm(ref.c1);
    if (nr < 0 || nc < 0) return null;
    return { ...ref, r1: nr, c1: nc, r2: nr, c2: nc };
  }

  if (ref.kind === 'cols') {
    const nc1 = cm(ref.c1);
    const nc2 = cm(ref.c2);
    if (nc1 < 0 || nc2 < 0) return null;
    return { ...ref, c1: nc1, c2: nc2 };
  }

  if (ref.kind === 'rows') {
    const nr1 = rm(ref.r1);
    const nr2 = rm(ref.r2);
    if (nr1 < 0 || nr2 < 0) return null;
    return { ...ref, r1: nr1, r2: nr2 };
  }

  // range: endpoints shrink to surviving rows/cols; interior inserts widen it.
  const start = firstSurviving(rm, ref.r1, ref.r2);
  const end = lastSurviving(rm, ref.r1, ref.r2);
  const cstart = firstSurviving(cm, ref.c1, ref.c2);
  const cend = lastSurviving(cm, ref.c1, ref.c2);
  if (!start || !end || !cstart || !cend) return null;
  return {
    ...ref,
    r1: Math.min(start.newIdx, end.newIdx),
    r2: Math.max(start.newIdx, end.newIdx),
    c1: Math.min(cstart.newIdx, cend.newIdx),
    c2: Math.max(cstart.newIdx, cend.newIdx),
  };
}

function translateRefText(value: string, ctx: TranslateContext): string {
  const ref = parseRef(value);
  if (!ref) return value; // opaque / unparseable → leave as-is
  const t = translateRef(ref, ctx);
  return t ? refToString(t) : REF_ERR;
}

/** Translate a whole formula's references through the maps (TDD §11.3). */
export function translateFormula(formula: string, ctx: TranslateContext): string {
  const toks = tokenize(formula);
  let out = '';
  for (const t of toks) {
    out += t.type === 'ref' ? translateRefText(t.value, ctx) : t.value;
  }
  return out;
}

function normalizeTokenValue(t: Token): string {
  if (t.type === 'function') return t.value.replace(/_xlfn\.|_xlws\./gi, '').toUpperCase();
  if (t.type === 'name') return t.value.toUpperCase();
  return t.value;
}

function normalizedTokens(formula: string): string {
  return tokenize(formula).map(normalizeTokenValue).join('\u0001');
}

/**
 * Formula equivalence (BR-C3): translate the old formula through the maps and
 * compare its token stream to the new formula's (whitespace already dropped,
 * function names case-insensitive, `_xlfn.`/`_xlws.` prefixes ignored).
 */
export function formulasEquivalent(
  oldFormula: string,
  newFormula: string,
  ctx: TranslateContext,
): boolean {
  const translated = translateFormula(oldFormula, ctx);
  return normalizedTokens(translated) === normalizedTokens(newFormula);
}
