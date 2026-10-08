import type { FeatureInventory } from '../ir/types.js';
import type { BlockedOp } from './types.js';

/**
 * Decide whether a row insert/delete on a sheet is unsafe (TDD §10.5). When a
 * pivot cache, chart series, drawing, comment, array/data-table formula or a
 * table body depends on the moved rows, the row operation is blocked (cell
 * edits still apply) and listed for manual action (FR-MRG-07).
 */
export function rowOpBlocked(
  features: FeatureInventory,
  sheet: string,
  atRow0: number,
): string | null {
  if (features.pivotSources.includes(sheet)) return 'a pivot table uses this sheet';
  if (features.charts.includes(sheet)) return 'a chart references this sheet';
  const drawings = features.drawingsAnchorRows[sheet];
  if (drawings && drawings.some((r) => r >= atRow0)) return 'a drawing is anchored on these rows';
  const comments = features.commentsBySheet[sheet];
  if (comments && comments.some((r) => r >= atRow0)) return 'comments are attached to these rows';
  if (features.extLstSqrefSheets.includes(sheet)) return 'newer conditional formats/validation reference these rows';
  const arrays = features.arrayFormulaRows[sheet];
  if (arrays && arrays.some((r) => r >= atRow0)) return 'an array/data-table formula covers these rows';
  return null;
}

export function blocked(sheet: string, key: string, op: BlockedOp['op'], reason: string): BlockedOp {
  return { sheet, key, op, reason };
}
