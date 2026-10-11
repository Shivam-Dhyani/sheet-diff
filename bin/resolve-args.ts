import type { Conflict, ConflictResolution } from '../src/merge/types.js';

/** A bad `--resolve` argument. The CLI reports it as a usage error (exit 2). */
export class ResolveArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolveArgError';
  }
}

type Choice = 'copy1' | 'copy2' | 'delete' | { both: string };

const CHOICES = 'Copy1, Copy2, delete, or both:NEWKEY for an add/add conflict';

/**
 * "Copy1", "copy 1", "COPY-1" → copy1; "delete" → delete; "both:INV-9-B" → keep both,
 * giving Copy 2's row the key INV-9-B (the key is taken as typed); else null.
 */
function parseChoice(raw: string): Choice | null {
  const both = /^\s*both\s*:(.*)$/is.exec(raw);
  if (both) return { both: both[1]!.trim() };
  const c = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return c === 'copy1' || c === 'copy2' || c === 'delete' ? c : null;
}

/**
 * Turn `--resolve KEY=CHOICE` arguments into engine resolutions, rejecting
 * anything that is not an exact, meaningful answer. Nothing is guessed: an
 * unknown choice, an unknown key, a duplicate, or a choice that does not fit the
 * conflict's type is an error, never a silent default (a wrong default here would
 * overwrite someone's edit without telling anyone).
 *
 * CopyN means "take that copy's side". Conflicts left without a `--resolve` are
 * not touched here; `resolveMerge` reports them as unresolved.
 */
export function resolveFromArgs(
  specs: string[],
  conflicts: Conflict[],
): Record<string, ConflictResolution> {
  const wanted = new Map<string, Choice>();
  for (const spec of specs) {
    const eq = spec.lastIndexOf('=');
    if (eq <= 0 || eq === spec.length - 1) {
      throw new ResolveArgError(
        `Bad --resolve "${spec}": expected KEY=CHOICE, e.g. INV-1003=Copy1 (choice: ${CHOICES}).`,
      );
    }
    const key = spec.slice(0, eq).trim();
    const raw = spec.slice(eq + 1);
    const choice = parseChoice(raw);
    if (!choice) {
      throw new ResolveArgError(`Unknown choice "${raw}" in --resolve ${key}=${raw}. Use ${CHOICES}.`);
    }
    if (wanted.has(key)) {
      throw new ResolveArgError(`--resolve ${key} was given more than once.`);
    }
    wanted.set(key, choice);
  }

  const conflictKeys = new Set(conflicts.map((c) => c.key).filter((k): k is string => k !== undefined));
  for (const key of wanted.keys()) {
    if (!conflictKeys.has(key)) {
      const known = [...conflictKeys].join(', ') || 'none';
      throw new ResolveArgError(`--resolve ${key}: no conflict has that key. Conflicts to resolve: ${known}.`);
    }
  }

  const out: Record<string, ConflictResolution> = {};
  for (const c of conflicts) {
    const choice = c.key === undefined ? undefined : wanted.get(c.key);
    if (choice) out[c.id] = toResolution(c, choice);
  }
  return out;
}

function toResolution(c: Conflict, choice: Choice): ConflictResolution {
  const key = c.key ?? c.id;
  if (typeof choice === 'object' && c.type !== 'ADD_ADD') {
    throw new ResolveArgError(
      `--resolve ${key}=both:…: only an ADD_ADD conflict (both copies added the same key) can keep both; ` +
        `${key} is a ${c.type} conflict. Use Copy1 or Copy2.`,
    );
  }
  switch (c.type) {
    case 'CELL':
    case 'RELATED_EDITS':
      if (choice === 'delete') {
        throw new ResolveArgError(
          `--resolve ${key}=delete: ${key} is a ${c.type} conflict, not a deleted row. Use Copy1 or Copy2.`,
        );
      }
      return choice === 'copy1' ? 'A' : 'B';

    case 'DELETE_EDIT': {
      if (choice === 'delete') return 'delete';
      // One copy deleted the row, the other edited it: taking a copy's side means
      // deleting if it deleted the row, keeping the row with the edits if it edited.
      const side = choice === 'copy1' ? 'A' : 'B';
      if (c.deletedBy !== 'A' && c.deletedBy !== 'B') {
        throw new ResolveArgError(`--resolve ${key}: cannot tell which copy deleted the row; use delete.`);
      }
      return side === c.deletedBy ? 'delete' : 'keepEdits';
    }

    case 'ADD_ADD': {
      // Both copies added a row with this key. CopyN keeps that copy's row; both:NEWKEY
      // keeps both, Copy 1's under the original key and Copy 2's under NEWKEY.
      if (choice === 'delete') {
        throw new ResolveArgError(
          `--resolve ${key}=delete: ${key} is an ADD_ADD conflict (both copies added it). ` +
            `Use Copy1, Copy2 or both:NEWKEY.`,
        );
      }
      if (typeof choice === 'object') {
        if (choice.both === '') {
          throw new ResolveArgError(`--resolve ${key}=both: needs the new key for Copy 2's row, e.g. both:${key}-B.`);
        }
        if (choice.both === key) {
          throw new ResolveArgError(`--resolve ${key}=both:${key}: the new key must differ from ${key}.`);
        }
        return { keepBoth: { aKey: key, bKey: choice.both } };
      }
      return choice === 'copy1' ? 'A' : 'B';
    }

    case 'STRUCTURE':
      throw new ResolveArgError(`--resolve ${key}: ${c.type} conflicts cannot be resolved from the command line.`);
  }
}
