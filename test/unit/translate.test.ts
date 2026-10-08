import { describe, it, expect } from 'vitest';
import { translateFormula, formulasEquivalent, type TranslateContext } from '../../src/formula/translate.js';

/** Build a context where a block of rows is deleted/inserted on one sheet. */
function ctx(shift: (r: number) => number, sheet = 'S'): TranslateContext {
  return {
    defaultSheet: sheet,
    rowMap: (_s, r) => shift(r),
    colMap: (_s, c) => c,
    rowCount: () => 1000,
    colCount: () => 100,
  };
}

describe('formula translation (BR-C3)', () => {
  it('leaves a range unchanged when rows are unchanged', () => {
    const identity = ctx((r) => r);
    expect(translateFormula('SUM(I5:I33)', identity)).toBe('SUM(I5:I33)');
    expect(formulasEquivalent('SUM(I5:I33)', 'SUM(I5:I33)', identity)).toBe(true);
  });

  it('shrinks a range end when a row inside is deleted (5:33 → 5:32)', () => {
    // row index 10 deleted; everything after shifts up by one (0-based rows).
    const del = ctx((r) => (r === 10 ? -1 : r > 10 ? r - 1 : r));
    // I5:I33 in 1-based = rows 4..32 (0-based). last surviving row 32 → maps to 31 → "I32".
    expect(translateFormula('SUM(I5:I33)', del)).toBe('SUM(I5:I32)');
  });

  it('extends a range end when a row is inserted inside (5:33 → 5:34)', () => {
    // a row inserted at index 10; rows >= 10 shift down by one.
    const ins = ctx((r) => (r >= 10 ? r + 1 : r));
    expect(translateFormula('SUM(I5:I33)', ins)).toBe('SUM(I5:I34)');
  });

  it('produces #REF! when the referenced cell is deleted', () => {
    const del = ctx((r) => (r === 4 ? -1 : r));
    expect(translateFormula('I5+1', del)).toBe('#REF!+1');
  });

  it('equivalence ignores whitespace and function-name case', () => {
    const identity = ctx((r) => r);
    expect(formulasEquivalent('sum( I5 : I33 )', 'SUM(I5:I33)', identity)).toBe(true);
  });
});
