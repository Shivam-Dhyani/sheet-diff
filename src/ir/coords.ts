/**
 * Coordinate helpers. The engine works in 0-based (r, c); A1 strings appear
 * only at the edges (TDD §1 rule 5).
 */

/** 0-based column index → column letters (0 → "A", 26 → "AA"). */
export function colToLetter(c: number): string {
  let n = c;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Column letters → 0-based column index ("A" → 0, "AA" → 26). */
export function letterToCol(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
}

/** (r, c) 0-based → A1 reference ("H12" for r=11, c=7). */
export function rcToA1(r: number, c: number): string {
  return `${colToLetter(c)}${r + 1}`;
}

const A1_RE = /^([A-Za-z]+)(\d+)$/;

/** A1 reference → (r, c) 0-based, or `null` when malformed. */
export function a1ToRc(ref: string): { r: number; c: number } | null {
  const m = A1_RE.exec(ref.trim());
  if (!m) return null;
  return { c: letterToCol(m[1]!.toUpperCase()), r: Number(m[2]) - 1 };
}

/** Row-major flat index into the columnar arrays. */
export function cellIndex(r: number, c: number, cols: number): number {
  return r * cols + c;
}
