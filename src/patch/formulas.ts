import { xmlEscape } from './zip.js';
import { translateFormula, type TranslateContext } from '../formula/translate.js';
import { tokenize } from '../formula/tokenizer.js';
import { parseRef } from '../formula/refs.js';
import { colToLetter } from '../ir/coords.js';
import type { ChangeSetExtendRange } from '../merge/types.js';

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const F_RE = /(<f\b[^>]*>)([\s\S]*?)(<\/f>)/;

/** Does a cell's raw XML carry a formula? */
export function hasFormula(raw: string): boolean {
  return F_RE.test(raw);
}

/**
 * Rewrite a cell's `<f>` body with `transform` (operates on the decoded
 * formula text, result is re-escaped). Also drops the cached `<v>` so a viewer
 * that does not recalc shows blank rather than a stale value (TDD §10.7). The
 * workbook's `fullCalcOnLoad` makes Excel/LibreOffice recompute on open.
 */
export function rewriteCellFormula(raw: string, transform: (f: string) => string): string {
  if (!F_RE.test(raw)) return raw;
  const rewritten = raw.replace(F_RE, (_full, open: string, inner: string, close: string) => {
    return open + xmlEscape(transform(decodeXml(inner))) + close;
  });
  // remove a trailing cached <v>…</v>
  return rewritten.replace(/<v>[\s\S]*?<\/v>/, '');
}

/** Translate a formula through a row/col map (BR-C3 / row shifts). */
export function makeTranslate(ctx: TranslateContext): (f: string) => string {
  return (f) => translateFormula(f, ctx);
}

/**
 * Apply extend-ranges to a formula on a given host sheet: rewrite each range end
 * that references an extended sheet range to the new end (TDD §9.2 / §10.4-5).
 */
export function applyExtendToFormula(
  formula: string,
  extendsForCell: ChangeSetExtendRange[],
): string {
  let out = formula;
  for (const e of extendsForCell) {
    out = out.replace(new RegExp(`:(\\$?)${escapeRe(e.from)}(?![0-9A-Za-z])`, 'g'), `:$1${e.to}`);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True if a formula references a range on one of the given sheets. */
export function referencesTableRange(formula: string, sheets: Set<string>, hostSheet: string): boolean {
  for (const t of tokenize(formula)) {
    if (t.type !== 'ref') continue;
    const ref = parseRef(t.value);
    if (!ref) continue;
    const target = ref.sheet ?? hostSheet;
    if (sheets.has(target) && (ref.kind === 'range' || ref.kind === 'cols')) return true;
  }
  return false;
}

/** A1 of a range-end column+row, used when emitting extend targets. */
export function endA1(col: number, row1: number): string {
  return `${colToLetter(col)}${row1}`;
}
