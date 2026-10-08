import { describe, it, expect } from 'vitest';
import { detectDelimiter, parseCsv, parseCsvNumber, detectEncoding } from '../../src/read/csv.js';

describe('CSV detection', () => {
  it('detects comma delimiter', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n4,5,6')).toBe(',');
  });

  it('detects semicolon delimiter', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';');
  });

  it('detects tab delimiter', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('parses quoted fields with embedded delimiters and newlines', () => {
    const { rows } = parseCsv(new TextEncoder().encode('a,"b,c","d\ne"\n1,2,3'));
    expect(rows[0]).toEqual(['a', 'b,c', 'd\ne']);
    expect(rows[1]).toEqual(['1', '2', '3']);
  });

  it('detects UTF-8 by default', () => {
    expect(detectEncoding(new TextEncoder().encode('héllo'))).toBe('utf-8');
  });

  it('classifies Indian and Western grouped numbers', () => {
    expect(parseCsvNumber('1,23,456.78')).toBeCloseTo(123456.78);
    expect(parseCsvNumber('123,456.78')).toBeCloseTo(123456.78);
    expect(parseCsvNumber('42')).toBe(42);
  });

  it('keeps leading-zero strings as text', () => {
    expect(parseCsvNumber('00123')).toBeNull();
    expect(parseCsvNumber('0123')).toBeNull();
  });

  it('rejects non-numeric text', () => {
    expect(parseCsvNumber('INV-1001')).toBeNull();
    expect(parseCsvNumber('')).toBeNull();
  });
});
