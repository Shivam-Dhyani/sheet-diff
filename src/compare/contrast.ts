import type { CompareResult, SheetPairResult } from '../types.js';

/**
 * The sheet pair the headline figures describe: the first compared pair that
 * has a real key (so the primary data sheet, not a small summary sheet), else
 * the first compared pair. Added/removed sheets are never primary.
 */
export function primaryPair(result: CompareResult): SheetPairResult | undefined {
  const compared = result.pairs.filter((p) => p.status === 'matched' || p.status === 'renamed');
  return compared.find((p) => p.key.mode !== 'order') ?? compared[0];
}

/**
 * "A basic cell-by-cell compare would flag N cells" (FR-RES-01).
 *
 * It describes the primary data sheet — a naive same-address compare of it —
 * not the sum across every sheet. Every surface that shows this line (report
 * model, CLI) must use this one function so they cannot disagree.
 */
export function contrastCells(result: CompareResult): number {
  const primary = primaryPair(result);
  if (!primary) return 0;
  return (
    result.positionalBaseline[primary.id] ??
    Object.values(result.positionalBaseline).reduce((a, b) => a + b, 0)
  );
}
