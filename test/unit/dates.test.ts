import { describe, it, expect } from 'vitest';
import { parseTextDate, serialToYmd, ymdKey } from '../../src/compare/dates.js';

describe('date parsing (BR-C5)', () => {
  it('parses DD-MM-YYYY by default (DMY)', () => {
    expect(ymdKey(parseTextDate('02-10-2026', 'DMY')!)).toBe('2026-10-02');
  });

  it('parses DD/MM/YYYY', () => {
    expect(ymdKey(parseTextDate('02/10/2026', 'DMY')!)).toBe('2026-10-02');
  });

  it('parses DD-Mon-YYYY', () => {
    expect(ymdKey(parseTextDate('02-Oct-2026', 'DMY')!)).toBe('2026-10-02');
  });

  it('parses ISO YYYY-MM-DD', () => {
    expect(ymdKey(parseTextDate('2026-10-02', 'DMY')!)).toBe('2026-10-02');
  });

  it('respects MDY order', () => {
    expect(ymdKey(parseTextDate('10/02/2026', 'MDY')!)).toBe('2026-10-02');
  });

  it('rejects invalid dates', () => {
    expect(parseTextDate('32-13-2026', 'DMY')).toBeNull();
    expect(parseTextDate('not a date', 'DMY')).toBeNull();
  });

  it('converts Excel serials (1900 system)', () => {
    // serial 1 = 1900-01-01; 44927 = 2023-01-01
    expect(ymdKey(serialToYmd(44927, false))).toBe('2023-01-01');
  });
});
