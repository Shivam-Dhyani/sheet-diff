import type { Scalar } from '../types.js';
import type { MergePlan, Resolutions, MergeLogRow, MergeSource } from './types.js';

function label(source: MergeSource, labels: [string, string]): string {
  if (source === 'A') return labels[0];
  if (source === 'B') return labels[1];
  return source; // 'both' | 'typed'
}

/**
 * Build the Merge Log rows in application order (TDD §9.4). Every applied
 * change appears with its source and decision (BR-M8). Derived from the plan
 * and resolutions so it mirrors exactly what `resolveMerge` applies.
 */
export function buildMergeLog(
  plan: MergePlan,
  resolutions: Resolutions,
  labels: [string, string],
): MergeLogRow[] {
  const rows: MergeLogRow[] = [];
  const unticked = new Set(resolutions.untickedProposals ?? []);
  const push = (r: Omit<MergeLogRow, 'n'>): void => {
    rows.push({ n: rows.length + 1, ...r });
  };

  for (const p of plan.proposals) {
    if (unticked.has(p.id)) continue;
    if (p.kind === 'cell' && p.column) {
      push({
        sheet: p.sheet,
        key: p.key,
        column: p.column,
        oldValue: p.base ?? null,
        newValue: p.value ?? null,
        source: label(p.source, labels),
        decision: 'auto',
        note: '',
      });
    } else if (p.kind === 'row_add') {
      push({
        sheet: p.sheet,
        key: p.key,
        column: '(new row)',
        oldValue: null,
        newValue: p.key,
        source: label(p.source, labels),
        decision: 'auto',
        note: p.afterKey ? `inserted after ${p.afterKey}` : 'inserted at top',
      });
    } else if (p.kind === 'row_delete') {
      push({
        sheet: p.sheet,
        key: p.key,
        column: '(row)',
        oldValue: p.key,
        newValue: '(deleted)',
        source: label(p.source, labels),
        decision: 'auto',
        note: '',
      });
    }
  }

  for (const c of plan.conflicts) {
    const choice = resolutions.conflicts[c.id];
    if (choice === undefined || choice === 'base') continue;
    if (c.type === 'CELL' && c.column) {
      const chosen: Scalar =
        typeof choice === 'object' && 'typed' in choice
          ? ((choice as { typed: Scalar }).typed)
          : choice === 'A'
            ? (c.aValue ?? null)
            : (c.bValue ?? null);
      const src = typeof choice === 'object' ? 'typed' : (choice as MergeSource);
      push({
        sheet: c.sheet,
        key: c.key ?? '',
        column: c.column,
        oldValue: c.base ?? null,
        newValue: chosen,
        source: label(src, labels),
        decision: `resolved: ${typeof choice === 'object' ? 'typed' : choice}`,
        note: 'conflict',
      });
    } else if (c.type === 'RELATED_EDITS') {
      const picks =
        choice === 'both'
          ? [...(c.aEdits ?? []).map((e) => ['A', e] as const), ...(c.bEdits ?? []).map((e) => ['B', e] as const)]
          : (choice === 'A' ? c.aEdits : c.bEdits)?.map((e) => [choice as MergeSource, e] as const) ?? [];
      for (const [src, e] of picks) {
        push({
          sheet: c.sheet,
          key: c.key ?? '',
          column: e.column,
          oldValue: e.base,
          newValue: e.value,
          source: label(src, labels),
          decision: `resolved: ${choice}`,
          note: 'related edits',
        });
      }
    } else if (c.type === 'DELETE_EDIT') {
      if (choice === 'delete') {
        push({
          sheet: c.sheet,
          key: c.key ?? '',
          column: '(row)',
          oldValue: c.key ?? '',
          newValue: '(deleted)',
          source: label(c.deletedBy ?? 'A', labels),
          decision: 'resolved: delete',
          note: 'delete/edit conflict',
        });
      } else if (choice === 'keepEdits') {
        for (const e of c.edits ?? []) {
          push({
            sheet: c.sheet,
            key: c.key ?? '',
            column: e.column,
            oldValue: e.base,
            newValue: e.value,
            source: label(c.editedBy ?? 'B', labels),
            decision: 'resolved: keep with edits',
            note: 'delete/edit conflict',
          });
        }
      }
    }
  }

  return rows;
}
