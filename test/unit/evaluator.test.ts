import { describe, it, expect } from 'vitest';
import { evaluateFormula, isUnknown, type EvalContext } from '../../src/formula/evaluator.js';
import type { CellScalar } from '../../src/formula/functions.js';

/** A tiny grid-backed context. `grid[r][c]` on sheet "S". */
function gridCtx(grid: CellScalar[][]): EvalContext {
  return {
    defaultSheet: 'S',
    sheetExists: (s) => s === 'S',
    rowCount: () => grid.length,
    colCount: () => Math.max(0, ...grid.map((r) => r.length)),
    getCell: (s, r, c) => (s === 'S' ? (grid[r]?.[c] ?? null) : null),
  };
}

describe('evaluator', () => {
  const g = gridCtx([
    [10, 20], // row 1
    [30, 40], // row 2
    [50, 60], // row 3
  ]);

  it('precedence: -2^2 = 4 (unary minus binds tighter than ^)', () => {
    expect(evaluateFormula('-2^2', g)).toBe(4);
  });

  it('standard precedence * over +', () => {
    expect(evaluateFormula('2+3*4', g)).toBe(14);
  });

  it('SUM over a range', () => {
    expect(evaluateFormula('SUM(A1:B3)', g)).toBe(210);
  });

  it('cell arithmetic', () => {
    expect(evaluateFormula('A1*B1', g)).toBe(200);
  });

  it('IF and comparison', () => {
    expect(evaluateFormula('IF(A1>5,"big","small")', g)).toBe('big');
  });

  it('SUMIF with a numeric criteria', () => {
    expect(evaluateFormula('SUMIF(A1:A3,">=30")', g)).toBe(80);
  });

  it('division by zero is an error', () => {
    const v = evaluateFormula('1/0', g);
    expect(v).toEqual({ err: '#DIV/0!' });
  });

  it('unknown function propagates as unknown', () => {
    expect(isUnknown(evaluateFormula('FORECAST.ETS(A1)', g))).toBe(true);
  });

  it('ROUND via formulajs', () => {
    expect(evaluateFormula('ROUND(1.2345,2)', g)).toBe(1.23);
  });

  it('SUBTOTAL(9, range) sums', () => {
    expect(evaluateFormula('SUBTOTAL(9,A1:A3)', g)).toBe(90);
  });
});
