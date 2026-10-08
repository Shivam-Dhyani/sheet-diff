import { jaccard } from './similarity.js';

export interface SheetSignature {
  name: string;
  /** Normalized header names. */
  headers: Set<string>;
  /** Sampled row hashes (≤ 200). */
  rowHashes: Set<bigint>;
}

export type SheetPairStatus = 'matched' | 'renamed';

export interface SheetPairing {
  oldName?: string;
  newName?: string;
  status: 'matched' | 'renamed' | 'added' | 'removed';
}

const SIMILARITY_THRESHOLD = 0.6;

function hashOverlap(a: Set<bigint>, b: Set<bigint>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

function similarity(a: SheetSignature, b: SheetSignature): number {
  return 0.6 * jaccard(a.headers, b.headers) + 0.4 * hashOverlap(a.rowHashes, b.rowHashes);
}

/** Pair sheets: exact name → case/space-insensitive → content similarity (TDD §7.3). */
export function pairSheets(oldSigs: SheetSignature[], newSigs: SheetSignature[]): SheetPairing[] {
  const pairings: SheetPairing[] = [];
  const oldUsed = new Set<number>();
  const newUsed = new Set<number>();

  const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

  // Pass 1: exact name.
  oldSigs.forEach((o, oi) => {
    const ni = newSigs.findIndex((n, j) => !newUsed.has(j) && n.name === o.name);
    if (ni >= 0) {
      oldUsed.add(oi);
      newUsed.add(ni);
      pairings.push({ oldName: o.name, newName: newSigs[ni]!.name, status: 'matched' });
    }
  });

  // Pass 2: case/space-insensitive name.
  oldSigs.forEach((o, oi) => {
    if (oldUsed.has(oi)) return;
    const ni = newSigs.findIndex((n, j) => !newUsed.has(j) && norm(n.name) === norm(o.name));
    if (ni >= 0) {
      oldUsed.add(oi);
      newUsed.add(ni);
      pairings.push({ oldName: o.name, newName: newSigs[ni]!.name, status: 'matched' });
    }
  });

  // Pass 3: content similarity, greedy by descending score.
  const candidates: { oi: number; ni: number; score: number }[] = [];
  oldSigs.forEach((o, oi) => {
    if (oldUsed.has(oi)) return;
    newSigs.forEach((n, ni) => {
      if (newUsed.has(ni)) return;
      const score = similarity(o, n);
      if (score >= SIMILARITY_THRESHOLD) candidates.push({ oi, ni, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score);
  for (const cand of candidates) {
    if (oldUsed.has(cand.oi) || newUsed.has(cand.ni)) continue;
    oldUsed.add(cand.oi);
    newUsed.add(cand.ni);
    pairings.push({ oldName: oldSigs[cand.oi]!.name, newName: newSigs[cand.ni]!.name, status: 'renamed' });
  }

  // Unpaired.
  oldSigs.forEach((o, oi) => {
    if (!oldUsed.has(oi)) pairings.push({ oldName: o.name, status: 'removed' });
  });
  newSigs.forEach((n, ni) => {
    if (!newUsed.has(ni)) pairings.push({ newName: n.name, status: 'added' });
  });

  return pairings;
}
