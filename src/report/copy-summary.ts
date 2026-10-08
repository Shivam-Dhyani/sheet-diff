import type { CompareResult } from '../types.js';

export interface CopySummaryOptions {
  maxLen?: number;
  product?: string;
}

/**
 * A plain-text summary for WhatsApp/email (FR-REP-03): High findings first,
 * ≤ 1,000 characters by default. No markup.
 */
export function buildCopySummary(result: CompareResult, opts?: CopySummaryOptions): string {
  const maxLen = opts?.maxLen ?? 1000;
  const product = opts?.product ?? 'SheetLens';
  const { counts } = result;

  if (counts.realChanges === 0) {
    return `${product}: no differences — the files contain the same data.`;
  }

  const head = `${product}: ${counts.realChanges} change${counts.realChanges === 1 ? '' : 's'}, ${counts.needsAttention} need attention`;
  const high = result.findings.filter((f) => f.severity === 'high');

  const items: string[] = [];
  high.forEach((f, i) => {
    const where = [f.key, f.column].filter(Boolean).join(' ');
    const label = where ? `${where} — ${f.title}` : f.title;
    items.push(`${i + 1}) ${label}`);
  });

  let out = items.length > 0 ? `${head} — ${items.join('; ')}` : head;
  if (out.length > maxLen) {
    out = out.slice(0, maxLen - 1).replace(/[;,\s]+\S*$/, '') + '…';
  }
  return out;
}
