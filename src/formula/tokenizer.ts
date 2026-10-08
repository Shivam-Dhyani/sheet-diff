/** Formula tokenizer (TDD §11.1). Input is formula text WITHOUT the leading `=`. */

export type TokenType =
  | 'number'
  | 'string'
  | 'boolean'
  | 'error'
  | 'operator'
  | 'paren'
  | 'brace'
  | 'separator'
  | 'function'
  | 'ref'
  | 'name'
  | 'structured'
  | 'external'
  | 'array'
  | 'whitespace';

export interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
}

const ERRORS = [
  '#REF!',
  '#N/A',
  '#VALUE!',
  '#DIV/0!',
  '#NAME?',
  '#NUM!',
  '#NULL!',
  '#SPILL!',
  '#CALC!',
  '#GETTING_DATA',
];

const TWO_CHAR_OPS = new Set(['<>', '<=', '>=']);
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '^', '&', '=', '<', '>', '%', ':', ' ']);

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
function isLetter(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || ch === '.' || ch === '\\';
}

/**
 * Tokenize formula text. Keeps whitespace tokens out of the stream (operators
 * are context-free here; the parser handles precedence). References, function
 * names, numbers, strings, errors, braces for array constants, and opaque
 * structured/external refs are all recognized.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  const push = (type: TokenType, start: number, end: number): void => {
    tokens.push({ type, value: input.slice(start, end), start, end });
  };

  while (i < n) {
    const ch = input[i]!;
    const start = i;

    // whitespace (skipped)
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // string
    if (ch === '"') {
      i++;
      while (i < n) {
        if (input[i] === '"') {
          if (input[i + 1] === '"') i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      push('string', start, i);
      continue;
    }

    // error literal
    if (ch === '#') {
      const err = ERRORS.find((e) => input.startsWith(e, i));
      if (err) {
        i += err.length;
        push('error', start, i);
        continue;
      }
    }

    // number (with optional decimal and exponent)
    if (isDigit(ch) || (ch === '.' && isDigit(input[i + 1] ?? ''))) {
      i++;
      while (i < n && (isDigit(input[i]!) || input[i] === '.')) i++;
      if (input[i] === 'e' || input[i] === 'E') {
        i++;
        if (input[i] === '+' || input[i] === '-') i++;
        while (i < n && isDigit(input[i]!)) i++;
      }
      push('number', start, i);
      continue;
    }

    // array constant {…}
    if (ch === '{') {
      let depth = 0;
      while (i < n) {
        if (input[i] === '{') depth++;
        else if (input[i] === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
      push('array', start, i);
      continue;
    }

    // parentheses
    if (ch === '(' || ch === ')') {
      i++;
      push('paren', start, i);
      continue;
    }

    // separators
    if (ch === ',' || ch === ';') {
      i++;
      push('separator', start, i);
      continue;
    }

    // operators (two-char then one-char). ' ' handled above, so range-op is ':'
    const two = input.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      i += 2;
      push('operator', start, i);
      continue;
    }
    if (ONE_CHAR_OPS.has(ch) && ch !== ' ') {
      i++;
      push('operator', start, i);
      continue;
    }

    // quoted sheet name: 'My ''Sheet''' !...
    if (ch === "'") {
      i++;
      while (i < n) {
        if (input[i] === "'") {
          if (input[i + 1] === "'") i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      // must be followed by ! to be a sheet-qualified reference
      if (input[i] === '!') {
        i++;
        consumeRefBody(input, () => i, (v) => (i = v), n);
        push('ref', start, i);
        continue;
      }
      push('name', start, i);
      continue;
    }

    // identifiers: references, functions, names, external/structured refs
    if (isLetter(ch) || ch === '$' || ch === '[') {
      // external ref [1]Sheet1!A1 or [path]...
      if (ch === '[') {
        let depth = 0;
        const save = i;
        while (i < n) {
          if (input[i] === '[') depth++;
          else if (input[i] === ']') {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
          i++;
        }
        // Could be a structured ref Table1[...] handled below via name prefix; here it's external file ref
        // consume following ref body
        consumeIdentBody(input, () => i, (v) => (i = v), n);
        push('external', save, i);
        continue;
      }

      // consume an identifier/reference chunk
      let j = i;
      while (j < n && (isLetter(input[j]!) || isDigit(input[j]!) || input[j] === '$' || input[j] === '!' || input[j] === ':' || input[j] === "'")) {
        j++;
      }
      const chunk = input.slice(i, j);

      // structured ref: Name[...]
      if (input[j] === '[') {
        let depth = 0;
        let k = j;
        while (k < n) {
          if (input[k] === '[') depth++;
          else if (input[k] === ']') {
            depth--;
            if (depth === 0) {
              k++;
              break;
            }
          }
          k++;
        }
        i = k;
        push('structured', start, i);
        continue;
      }

      // function call: identifier immediately followed by '(' (included in token)
      if (input[j] === '(') {
        i = j + 1;
        push('function', start, i);
        continue;
      }

      i = j;
      if (looksLikeRef(chunk)) push('ref', start, i);
      else if (chunk.toUpperCase() === 'TRUE' || chunk.toUpperCase() === 'FALSE') push('boolean', start, i);
      else push('name', start, i);
      continue;
    }

    // unknown char: emit as operator to avoid infinite loop
    i++;
    push('operator', start, i);
  }

  return tokens;
}

function consumeRefBody(
  input: string,
  get: () => number,
  set: (v: number) => void,
  n: number,
): void {
  let i = get();
  while (i < n && (/[A-Za-z0-9$:.]/.test(input[i]!))) i++;
  set(i);
}

function consumeIdentBody(
  input: string,
  get: () => number,
  set: (v: number) => void,
  n: number,
): void {
  let i = get();
  while (i < n && /[A-Za-z0-9$:!.']/.test(input[i]!)) i++;
  set(i);
}

/** A1-style reference heuristic: contains a sheet prefix or looks like col/row refs. */
export function looksLikeRef(chunk: string): boolean {
  const body = chunk.includes('!') ? chunk.slice(chunk.lastIndexOf('!') + 1) : chunk;
  if (chunk.includes('!')) return true;
  // cell / range / whole col / whole row
  return (
    /^\$?[A-Za-z]{1,3}\$?\d{1,7}(:\$?[A-Za-z]{1,3}\$?\d{1,7})?$/.test(body) ||
    /^\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}$/.test(body) ||
    /^\$?\d{1,7}:\$?\d{1,7}$/.test(body)
  );
}
