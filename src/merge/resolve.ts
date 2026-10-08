import type { WorkbookIR } from '../ir/types.js';
import { SheetDiffError } from '../errors.js';
import type { CompareOptions } from '../options.js';
import type {
  MergePlan,
  Resolutions,
  MergeChangeSet,
  ChangeSetCellEdit,
  ChangeSetRowInsert,
  ChangeSetRowDelete,
  Conflict,
  CellEdit,
  MergeSource,
  CellResolution,
} from './types.js';
import { computeExtendRanges } from './impact.js';

export interface ResolveOptions {
  extendTotals: boolean;
}

/**
 * Turn a plan plus the user's resolutions into a concrete change set
 * (TDD §9.2). Every conflict must be resolved (BR-M8 / `MERGE_UNRESOLVED`).
 * `base` is required so extend-ranges can be computed on the virtual model.
 */
export function resolveMerge(
  base: WorkbookIR,
  plan: MergePlan,
  resolutions: Resolutions,
  opts: ResolveOptions,
  compareOpts?: Partial<CompareOptions>,
): MergeChangeSet {
  const unresolved = plan.conflicts.filter((c) => resolutions.conflicts[c.id] === undefined);
  if (unresolved.length > 0) {
    throw new SheetDiffError('MERGE_UNRESOLVED', `Resolve ${unresolved.length} conflict(s) to download.`, {
      conflicts: unresolved.map((c) => c.id),
    });
  }

  const unticked = new Set(resolutions.untickedProposals ?? []);
  const cellEdits: ChangeSetCellEdit[] = [];
  const rowInserts: ChangeSetRowInsert[] = [];
  const rowDeletes: ChangeSetRowDelete[] = [];

  // Auto-proposals.
  for (const p of plan.proposals) {
    if (unticked.has(p.id)) continue;
    if (p.kind === 'cell' && p.column) {
      cellEdits.push(cellEdit(p.sheet, p.key, p.column, p.value ?? null, p.formula, p.source));
    } else if (p.kind === 'row_add') {
      const ins: ChangeSetRowInsert = {
        sheet: p.sheet,
        key: p.key,
        afterKey: p.afterKey ?? null,
        cells: p.cells ?? [],
        source: p.source,
      };
      if (p.sourceRow !== undefined) ins.sourceRow = p.sourceRow;
      rowInserts.push(ins);
    } else if (p.kind === 'row_delete') {
      rowDeletes.push({ sheet: p.sheet, key: p.key, source: p.source });
    }
  }

  // Conflicts.
  for (const c of plan.conflicts) {
    const choice = resolutions.conflicts[c.id]!;
    applyConflict(c, choice, resolutions, cellEdits, rowDeletes);
  }

  const changeSet: MergeChangeSet = { cellEdits, rowInserts, rowDeletes, extendRanges: [] };

  if (opts.extendTotals) {
    changeSet.extendRanges = computeExtendRanges(base, changeSet, compareOpts);
  }

  return changeSet;
}

function applyConflict(
  c: Conflict,
  choice: Resolutions['conflicts'][string],
  resolutions: Resolutions,
  cellEdits: ChangeSetCellEdit[],
  rowDeletes: ChangeSetRowDelete[],
): void {
  const key = c.key ?? '';
  switch (c.type) {
    case 'CELL': {
      if (choice === 'base') return;
      if (typeof choice === 'object' && 'typed' in choice) {
        cellEdits.push(cellEdit(c.sheet, key, c.column!, (choice as { typed: unknown }).typed as never, undefined, 'typed'));
        return;
      }
      const value = choice === 'A' ? c.aValue : c.bValue;
      cellEdits.push(cellEdit(c.sheet, key, c.column!, value ?? null, undefined, choice as MergeSource));
      return;
    }
    case 'RELATED_EDITS': {
      if (choice === 'base') return;
      if (choice === 'both') {
        if (!resolutions.acknowledgeRelated?.[c.id]) {
          throw new SheetDiffError(
            'MERGE_UNRESOLVED',
            `Accepting both edits on ${key} needs an explicit acknowledgement.`,
            { conflict: c.id },
          );
        }
        pushEdits(c.sheet, key, c.aEdits ?? [], 'A', cellEdits);
        pushEdits(c.sheet, key, c.bEdits ?? [], 'B', cellEdits);
        return;
      }
      pushEdits(c.sheet, key, (choice === 'A' ? c.aEdits : c.bEdits) ?? [], choice as MergeSource, cellEdits);
      return;
    }
    case 'DELETE_EDIT': {
      if (choice === 'base') return;
      if (choice === 'delete') {
        rowDeletes.push({ sheet: c.sheet, key, source: c.deletedBy ?? 'A' });
        return;
      }
      // keepEdits
      pushEdits(c.sheet, key, c.edits ?? [], c.editedBy ?? 'B', cellEdits);
      return;
    }
    case 'ADD_ADD':
      // 'A' | 'B' choose one copy's row; handled as an insert in the UI layer.
      // (Not exercised by the Phase-1 fixture; kept minimal.)
      return;
    case 'STRUCTURE':
      return;
  }
}

function pushEdits(
  sheet: string,
  key: string,
  edits: CellEdit[],
  source: MergeSource,
  out: ChangeSetCellEdit[],
): void {
  for (const e of edits) out.push(cellEdit(sheet, key, e.column, e.value, e.formula, source));
}

function cellEdit(
  sheet: string,
  key: string,
  column: string,
  value: ChangeSetCellEdit['value'] | null,
  formula: string | undefined,
  source: MergeSource,
): ChangeSetCellEdit {
  const e: ChangeSetCellEdit = { sheet, key, column, source };
  if (formula !== undefined) e.formula = formula;
  else e.value = value ?? null;
  return e;
}

/** Narrowing helper exported for the CLI/UI. */
export function isTypedCell(choice: CellResolution): choice is Extract<CellResolution, object> {
  return typeof choice === 'object' && choice !== null && 'typed' in choice;
}
