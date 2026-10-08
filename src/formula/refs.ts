import { colToLetter, letterToCol } from '../ir/coords.js';

export type RefKind = 'cell' | 'range' | 'cols' | 'rows';

/** A parsed reference. Rows/cols are 0-based; -1 means "unbounded" for whole col/row. */
export interface Ref {
  sheet?: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  absR1: boolean;
  absC1: boolean;
  absR2: boolean;
  absC2: boolean;
  kind: RefKind;
}

interface A1Part {
  col: number | null;
  row: number | null;
  absCol: boolean;
  absRow: boolean;
}

function parseA1Part(s: string): A1Part | null {
  const m = /^(\$?)([A-Za-z]{0,3})(\$?)(\d{0,7})$/.exec(s);
  if (!m) return null;
  const [, dollarCol, letters, dollarRow, digits] = m;
  const hasCol = letters !== '';
  const hasRow = digits !== '';
  if (!hasCol && !hasRow) return null;
  return {
    col: hasCol ? letterToCol(letters!.toUpperCase()) : null,
    row: hasRow ? Number(digits) - 1 : null,
    absCol: dollarCol === '$',
    absRow: dollarRow === '$',
  };
}

/** Parse a reference string (possibly sheet-qualified) into a {@link Ref}. */
export function parseRef(input: string): Ref | null {
  let sheet: string | undefined;
  let body = input;
  const bang = input.lastIndexOf('!');
  if (bang >= 0) {
    let s = input.slice(0, bang);
    if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1).replace(/''/g, "'");
    sheet = s;
    body = input.slice(bang + 1);
  }

  const parts = body.split(':');
  if (parts.length === 1) {
    const p = parseA1Part(parts[0]!);
    if (!p || p.col === null || p.row === null) return null;
    return {
      ...(sheet !== undefined ? { sheet } : {}),
      r1: p.row,
      c1: p.col,
      r2: p.row,
      c2: p.col,
      absR1: p.absRow,
      absC1: p.absCol,
      absR2: p.absRow,
      absC2: p.absCol,
      kind: 'cell',
    };
  }

  if (parts.length === 2) {
    const a = parseA1Part(parts[0]!);
    const b = parseA1Part(parts[1]!);
    if (!a || !b) return null;

    // whole columns (A:C)
    if (a.row === null && b.row === null && a.col !== null && b.col !== null) {
      return {
        ...(sheet !== undefined ? { sheet } : {}),
        r1: -1,
        c1: a.col,
        r2: -1,
        c2: b.col,
        absR1: false,
        absC1: a.absCol,
        absR2: false,
        absC2: b.absCol,
        kind: 'cols',
      };
    }
    // whole rows (1:5)
    if (a.col === null && b.col === null && a.row !== null && b.row !== null) {
      return {
        ...(sheet !== undefined ? { sheet } : {}),
        r1: a.row,
        c1: -1,
        r2: b.row,
        c2: -1,
        absR1: a.absRow,
        absC1: false,
        absR2: b.absRow,
        absC2: false,
        kind: 'rows',
      };
    }
    if (a.col === null || a.row === null || b.col === null || b.row === null) return null;
    return {
      ...(sheet !== undefined ? { sheet } : {}),
      r1: a.row,
      c1: a.col,
      r2: b.row,
      c2: b.col,
      absR1: a.absRow,
      absC1: a.absCol,
      absR2: b.absRow,
      absC2: b.absCol,
      kind: 'range',
    };
  }

  return null;
}

function cellStr(c: number, r: number, absC: boolean, absR: boolean): string {
  return `${absC ? '$' : ''}${colToLetter(c)}${absR ? '$' : ''}${r + 1}`;
}

/** Serialize a {@link Ref} back to A1 text (no sheet prefix unless present). */
export function refToString(ref: Ref): string {
  const prefix = ref.sheet !== undefined ? sheetPrefix(ref.sheet) : '';
  switch (ref.kind) {
    case 'cell':
      return prefix + cellStr(ref.c1, ref.r1, ref.absC1, ref.absR1);
    case 'range':
      return (
        prefix +
        cellStr(ref.c1, ref.r1, ref.absC1, ref.absR1) +
        ':' +
        cellStr(ref.c2, ref.r2, ref.absC2, ref.absR2)
      );
    case 'cols':
      return `${prefix}${ref.absC1 ? '$' : ''}${colToLetter(ref.c1)}:${ref.absC2 ? '$' : ''}${colToLetter(ref.c2)}`;
    case 'rows':
      return `${prefix}${ref.absR1 ? '$' : ''}${ref.r1 + 1}:${ref.absR2 ? '$' : ''}${ref.r2 + 1}`;
  }
}

function sheetPrefix(sheet: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet) ? `${sheet}!` : `'${sheet.replace(/'/g, "''")}'!`;
}
