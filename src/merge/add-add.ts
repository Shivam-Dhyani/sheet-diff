/**
 * ADD_ADD resolution (BR-M6, FR-MRG-03): both copies added a row with the same
 * key but different content. The user keeps Copy 1's row, Copy 2's row, or both
 * under different keys. Also holds the check that every answer fits its conflict.
 */
import { SheetDiffError } from '../errors.js';
import type { Scalar } from '../types.js';
import type {
  AddAddResolution,
  ChangeSetRowInsert,
  Conflict,
  ConflictResolution,
  KeepBothResolution,
  RowCell,
} from './types.js';

export function isKeepBoth(choice: unknown): choice is KeepBothResolution {
  return typeof choice === 'object' && choice !== null && 'keepBoth' in choice;
}

function invalid(c: Conflict, message: string): SheetDiffError {
  return new SheetDiffError('MERGE_INVALID_RESOLUTION', message, { conflict: c.id });
}

const ALLOWED: Partial<Record<Conflict['type'], readonly string[]>> = {
  CELL: ['A', 'B', 'base'],
  RELATED_EDITS: ['A', 'B', 'base', 'both'],
  DELETE_EDIT: ['delete', 'keepEdits', 'base'],
  ADD_ADD: ['A', 'B'],
};

/**
 * Reject an answer that does not belong to the conflict's type, instead of letting
 * it fall through to some other branch (e.g. `delete` on a cell conflict silently
 * picking Copy 2). A typed value is only valid for CELL, keep-both only for ADD_ADD.
 */
export function assertChoiceFits(c: Conflict, choice: ConflictResolution): void {
  const where = `${c.type} conflict on ${c.key ?? c.id}`;
  if (typeof choice === 'object' && choice !== null) {
    if (c.type === 'CELL' && 'typed' in choice) return;
    if (c.type === 'ADD_ADD' && isKeepBoth(choice)) return;
    throw invalid(c, `That answer does not apply to the ${where}.`);
  }
  const allowed = ALLOWED[c.type];
  if (!allowed || allowed.includes(choice)) return;
  const hint =
    c.type === 'ADD_ADD' && choice === 'both'
      ? 'To keep both rows give each its own key: { keepBoth: { aKey, bKey } }.'
      : `Use ${allowed.join(', ')}${c.type === 'CELL' ? ' or { typed }' : ''}.`;
  throw invalid(c, `"${String(choice)}" is not a valid answer for the ${where}. ${hint}`);
}

/** A key typed back into the row's key cell keeps a number a number. */
function coerceLike(original: Scalar | undefined, text: string): Scalar {
  if (typeof original === 'number') {
    const n = Number(text);
    if (text !== '' && Number.isFinite(n) && String(n) === text) return n;
  }
  return text;
}

/** Copy `cells` with the key column(s) rewritten so the row's key becomes `newKey`. */
function rekey(c: Conflict, cells: RowCell[], newKey: string): RowCell[] {
  const cols = c.keyColumns ?? [];
  if (cols.length === 0) {
    throw invalid(c, `This sheet's key columns are unknown, so a row cannot be given a new key.`);
  }
  const parts = cols.length === 1 ? [newKey] : newKey.split(' / ');
  if (parts.length !== cols.length) {
    throw invalid(
      c,
      `The key for ${c.key ?? c.id} has ${cols.length} parts (${cols.join(' / ')}); separate them with " / ".`,
    );
  }
  const out = cells.map((x) => ({ ...x }));
  cols.forEach((col, i) => {
    const at = out.findIndex((x) => x.column === col);
    if (at < 0) throw invalid(c, `The added row has no "${col}" cell to hold its new key.`);
    // The key cell becomes a plain value (a key is never a formula).
    out[at] = { column: col, value: coerceLike(out[at]!.value, parts[i]!.trim()) };
  });
  return out;
}

/**
 * The inserted row(s) for an ADD_ADD answer. `used` holds every key already taken
 * on the sheet (the Original's rows, other new rows); the keys this answer claims
 * are checked against it and then added to it, so no two rows end up sharing a key.
 */
export function addAddInserts(
  c: Conflict,
  choice: AddAddResolution,
  used: Set<string>,
): ChangeSetRowInsert[] {
  const key = c.key ?? '';
  const aAfter = c.afterKey ?? null;
  const bAfter = c.bAfterKey !== undefined ? c.bAfterKey : aAfter;

  const side = (
    source: 'A' | 'B',
    finalKey: string,
  ): ChangeSetRowInsert => {
    const cells = (source === 'A' ? c.aCells : c.bCells) ?? [];
    const sourceRow = source === 'A' ? c.aSourceRow : c.bSourceRow;
    const ins: ChangeSetRowInsert = {
      sheet: c.sheet,
      key: finalKey,
      afterKey: source === 'A' ? aAfter : bAfter,
      cells: finalKey === key ? cells : rekey(c, cells, finalKey),
      source,
    };
    if (sourceRow !== undefined) ins.sourceRow = sourceRow;
    return ins;
  };

  const claim = (...keys: string[]): void => {
    for (const k of keys) {
      if (used.has(k)) {
        throw invalid(c, `The key "${k}" is already used by another row. Choose a key that is not taken.`);
      }
    }
    for (const k of keys) used.add(k);
  };

  if (choice === 'A' || choice === 'B') {
    claim(key);
    return [side(choice, key)];
  }

  const aKey = choice.keepBoth.aKey.trim();
  const bKey = choice.keepBoth.bKey.trim();
  if (aKey === '' || bKey === '') {
    throw invalid(c, `Keeping both rows needs a key for each of them.`);
  }
  if (aKey === bKey) {
    throw invalid(c, `Keeping both rows needs two different keys; both are "${aKey}".`);
  }
  claim(aKey, bKey);
  return [side('A', aKey), side('B', bKey)];
}
