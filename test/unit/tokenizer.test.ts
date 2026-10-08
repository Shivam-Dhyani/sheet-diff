import { describe, it, expect } from 'vitest';
import { tokenize } from '../../src/formula/tokenizer.js';

const types = (f: string): string[] => tokenize(f).map((t) => t.type);
const values = (f: string): string[] => tokenize(f).map((t) => t.value);

describe('tokenizer', () => {
  it('tokenizes a simple arithmetic formula', () => {
    expect(values('I18*J18')).toEqual(['I18', '*', 'J18']);
    expect(types('I18*J18')).toEqual(['ref', 'operator', 'ref']);
  });

  it('recognizes function calls and ranges', () => {
    const t = tokenize('SUM(I5:I33)');
    expect(t[0]).toMatchObject({ type: 'function', value: 'SUM(' });
    expect(t[1]).toMatchObject({ type: 'ref', value: 'I5:I33' });
  });

  it('handles absolute refs and sheet prefixes', () => {
    expect(types("'Sales Register'!$A$1")).toEqual(['ref']);
    expect(types('Sheet1!A1:B2')).toEqual(['ref']);
  });

  it('parses strings with escaped quotes', () => {
    const t = tokenize('"a ""b"" c"');
    expect(t).toHaveLength(1);
    expect(t[0]!.type).toBe('string');
  });

  it('recognizes error literals', () => {
    expect(types('#REF!')).toEqual(['error']);
    expect(types('#DIV/0!')).toEqual(['error']);
  });

  it('recognizes numbers with exponents and decimals', () => {
    expect(types('1.5e-3')).toEqual(['number']);
    expect(types('.5')).toEqual(['number']);
  });

  it('treats structured and array refs as opaque tokens', () => {
    expect(types('Table1[[#This Row],[Col]]')).toEqual(['structured']);
    expect(types('{1,2;3,4}')).toEqual(['array']);
  });

  it('two-char operators', () => {
    expect(values('A1<>B1')).toEqual(['A1', '<>', 'B1']);
    expect(values('A1>=B1')).toEqual(['A1', '>=', 'B1']);
  });
});
