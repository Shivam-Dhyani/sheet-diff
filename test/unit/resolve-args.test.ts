import { describe, it, expect } from 'vitest';
import { resolveFromArgs, ResolveArgError } from '../../bin/resolve-args.js';
import type { Conflict } from '../../src/merge/types.js';

const cell: Conflict = { id: 'CELL:S:INV-1003:Qty', type: 'CELL', sheet: 'S', key: 'INV-1003', column: 'Qty' };
const related: Conflict = { id: 'REL:S:INV-1008', type: 'RELATED_EDITS', sheet: 'S', key: 'INV-1008' };
// Copy 1 (A) deleted the row, Copy 2 (B) edited it — as in the merge fixture.
const delEdit: Conflict = {
  id: 'DE:S:INV-1019',
  type: 'DELETE_EDIT',
  sheet: 'S',
  key: 'INV-1019',
  deletedBy: 'A',
  editedBy: 'B',
};
const addAdd: Conflict = { id: 'ADD_ADD:S:INV-1031', type: 'ADD_ADD', sheet: 'S', key: 'INV-1031' };
const all = [cell, related, delEdit, addAdd];

const err = (specs: string[], conflicts = all): string => {
  try {
    resolveFromArgs(specs, conflicts);
  } catch (e) {
    expect(e).toBeInstanceOf(ResolveArgError);
    return (e as Error).message;
  }
  throw new Error('expected resolveFromArgs to throw');
};

describe('resolveFromArgs — valid answers', () => {
  it('maps CopyN to the engine sides for CELL and RELATED_EDITS', () => {
    expect(resolveFromArgs(['INV-1003=Copy1', 'INV-1008=Copy2'], all)).toEqual({
      [cell.id]: 'A',
      [related.id]: 'B',
    });
  });

  it('is forgiving about case and spacing of the choice only', () => {
    const r = resolveFromArgs(['INV-1003=copy 2'], all);
    expect(r[cell.id]).toBe('B');
    expect(resolveFromArgs(['INV-1003=COPY-1'], all)[cell.id]).toBe('A');
  });

  it('an add/add conflict: Copy1 / Copy2 keep that copy\'s row', () => {
    expect(resolveFromArgs(['INV-1031=Copy1'], all)[addAdd.id]).toBe('A');
    expect(resolveFromArgs(['INV-1031=copy 2'], all)[addAdd.id]).toBe('B');
  });

  it('an add/add conflict: both:NEWKEY keeps both, Copy 2\'s row under the new key', () => {
    expect(resolveFromArgs(['INV-1031=both:INV-1031-B'], all)[addAdd.id]).toEqual({
      keepBoth: { aKey: 'INV-1031', bKey: 'INV-1031-B' },
    });
  });

  it('the new key is taken as typed (spaces, case and punctuation kept; trimmed at the ends)', () => {
    expect(resolveFromArgs(['INV-1031=BOTH:  Inv 1031_b '], all)[addAdd.id]).toEqual({
      keepBoth: { aKey: 'INV-1031', bKey: 'Inv 1031_b' },
    });
  });

  it('"delete" resolves a delete-vs-edit conflict', () => {
    expect(resolveFromArgs(['INV-1019=delete'], all)[delEdit.id]).toBe('delete');
  });

  it('CopyN on a delete-vs-edit conflict means "take that copy\'s side"', () => {
    // Copy 1 deleted the row → delete. Copy 2 edited it → keep the row with its edits.
    expect(resolveFromArgs(['INV-1019=Copy1'], all)[delEdit.id]).toBe('delete');
    expect(resolveFromArgs(['INV-1019=Copy2'], all)[delEdit.id]).toBe('keepEdits');
    // …and it flips when the roles are swapped.
    const swapped: Conflict = { ...delEdit, deletedBy: 'B', editedBy: 'A' };
    expect(resolveFromArgs(['INV-1019=Copy1'], [swapped])[delEdit.id]).toBe('keepEdits');
    expect(resolveFromArgs(['INV-1019=Copy2'], [swapped])[delEdit.id]).toBe('delete');
  });

  it('leaves conflicts without a --resolve out (resolveMerge reports them)', () => {
    expect(resolveFromArgs(['INV-1003=Copy1'], all)).toEqual({ [cell.id]: 'A' });
    expect(resolveFromArgs([], all)).toEqual({});
  });

  it('applies one answer to every conflict on the same key', () => {
    const qty = { ...cell, id: 'c1' };
    const rate = { ...cell, id: 'c2', column: 'Rate' };
    expect(resolveFromArgs(['INV-1003=Copy2'], [qty, rate])).toEqual({ c1: 'B', c2: 'B' });
  });
});

describe('resolveFromArgs — rejects instead of guessing', () => {
  it('unknown choice (the silent-Copy-1 bug)', () => {
    expect(err(['INV-1003=Ravi'])).toMatch(/Unknown choice "Ravi"/);
    expect(err(['INV-1003=Priya'])).toMatch(/Unknown choice "Priya"/);
    expect(err(['INV-1003=copy3'])).toMatch(/Unknown choice/);
    expect(err(['INV-1003=base'])).toMatch(/Use Copy1, Copy2, delete, or both:NEWKEY/);
  });

  it('malformed arguments', () => {
    expect(err(['INV-1003'])).toMatch(/expected KEY=CHOICE/);
    expect(err(['=Copy1'])).toMatch(/expected KEY=CHOICE/);
    expect(err(['INV-1003='])).toMatch(/expected KEY=CHOICE/);
    expect(err([''])).toMatch(/expected KEY=CHOICE/);
  });

  it('unknown key, listing the real ones', () => {
    const m = err(['INV-1O03=Copy1']); // letter O, not zero
    expect(m).toMatch(/no conflict has that key/);
    expect(m).toContain('INV-1003');
    expect(m).toContain('INV-1019');
  });

  it('a key with no conflicts at all', () => {
    expect(err(['INV-1003=Copy1'], [])).toMatch(/Conflicts to resolve: none/);
  });

  it('the same key twice, even when both answers agree', () => {
    expect(err(['INV-1003=Copy1', 'INV-1003=Copy2'])).toMatch(/more than once/);
    expect(err(['INV-1003=Copy1', 'INV-1003=Copy1'])).toMatch(/more than once/);
  });

  it('"delete" on a conflict that is not a deleted row', () => {
    expect(err(['INV-1003=delete'])).toMatch(/CELL conflict, not a deleted row/);
    expect(err(['INV-1008=delete'])).toMatch(/RELATED_EDITS/);
  });

  it('"delete" on an add/add conflict', () => {
    expect(err(['INV-1031=delete'])).toMatch(/ADD_ADD conflict \(both copies added it\)/);
  });

  it('keep-both on a conflict that is not add/add', () => {
    expect(err(['INV-1003=both:INV-1003-B'])).toMatch(/only an ADD_ADD conflict/);
    expect(err(['INV-1019=both:x'])).toMatch(/DELETE_EDIT/);
  });

  it('keep-both without a usable new key', () => {
    expect(err(['INV-1031=both:'])).toMatch(/needs the new key/);
    expect(err(['INV-1031=both:   '])).toMatch(/needs the new key/);
    expect(err(['INV-1031=both:INV-1031'])).toMatch(/must differ from INV-1031/);
  });

  it('a delete-vs-edit conflict where the deleter is unknown (defensive)', () => {
    const odd: Conflict = { id: delEdit.id, type: 'DELETE_EDIT', sheet: 'S', key: 'INV-1019', editedBy: 'B' };
    expect(err(['INV-1019=Copy1'], [odd])).toMatch(/cannot tell which copy deleted/);
    expect(resolveFromArgs(['INV-1019=delete'], [odd])[delEdit.id]).toBe('delete');
  });
});
