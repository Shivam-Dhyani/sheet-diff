import type { Scalar } from '../types.js';

const AMOUNT_HEADER_RE = /₹|rs|amount|value|total|price|rate|tax|gst/i;

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function isAmountColumn(header: string): boolean {
  return AMOUNT_HEADER_RE.test(header);
}

export function formatINR(n: number): string {
  return INR.format(n);
}

/** Format a scalar for display in a message, using ₹ for amount columns. */
export function formatValue(v: Scalar, header?: string): string {
  if (v === null) return '(blank)';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    return header && isAmountColumn(header) ? formatINR(v) : String(v);
  }
  return v;
}

/** A stable id for a finding, derived from (rule, pair, key, column). */
export function findingId(rule: string, pairId?: string, key?: string, column?: string): string {
  const s = `${rule}|${pairId ?? ''}|${key ?? ''}|${column ?? ''}`;
  // FNV-1a 32-bit → hex (stable across runs).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${rule}-${h.toString(16).padStart(8, '0')}`;
}
