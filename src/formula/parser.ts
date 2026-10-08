import { tokenize, type Token } from './tokenizer.js';
import { parseRef, type Ref } from './refs.js';

export type Node =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'error'; value: string }
  | { type: 'ref'; ref: Ref; raw: string }
  | { type: 'name'; name: string }
  | { type: 'unary'; op: string; operand: Node }
  | { type: 'postfix'; op: string; operand: Node }
  | { type: 'binary'; op: string; left: Node; right: Node }
  | { type: 'call'; name: string; args: Node[] }
  | { type: 'opaque'; raw: string };

// Binding powers (higher binds tighter). TDD §11.4 precedence.
const INFIX_BP: Record<string, [number, number]> = {
  '=': [1, 2],
  '<>': [1, 2],
  '<': [1, 2],
  '>': [1, 2],
  '<=': [1, 2],
  '>=': [1, 2],
  '&': [3, 4],
  '+': [5, 6],
  '-': [5, 6],
  '*': [7, 8],
  '/': [7, 8],
  '^': [9, 10],
  ':': [15, 16],
};
const UNARY_BP = 13; // unary minus (binds tighter than ^ so -2^2 = 4 via special-case below)
const POSTFIX_BP = 11; // %

class Parser {
  private pos = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }
  private next(): Token | undefined {
    return this.toks[this.pos++];
  }

  parse(): Node {
    const node = this.parseExpr(0);
    return node;
  }

  private parseExpr(minBp: number): Node {
    let left = this.parsePrefix();
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.type === 'operator' && t.value === '%') {
        if (POSTFIX_BP < minBp) break;
        this.next();
        left = { type: 'postfix', op: '%', operand: left };
        continue;
      }
      if (t.type !== 'operator') break;
      const bp = INFIX_BP[t.value];
      if (!bp || bp[0] < minBp) break;
      this.next();
      const right = this.parseExpr(bp[1]);
      left = { type: 'binary', op: t.value, left, right };
    }
    return left;
  }

  private parsePrefix(): Node {
    const t = this.next();
    if (!t) return { type: 'opaque', raw: '' };
    switch (t.type) {
      case 'number':
        return { type: 'number', value: Number(t.value) };
      case 'string':
        return { type: 'string', value: unquote(t.value) };
      case 'boolean':
        return { type: 'boolean', value: t.value.toUpperCase() === 'TRUE' };
      case 'error':
        return { type: 'error', value: t.value };
      case 'ref': {
        const ref = parseRef(t.value);
        return ref ? { type: 'ref', ref, raw: t.value } : { type: 'opaque', raw: t.value };
      }
      case 'name':
        return { type: 'name', name: t.value };
      case 'function':
        return this.parseCall(t.value.replace(/\($/, ''));
      case 'operator':
        if (t.value === '-') {
          // unary minus binds tighter than ^ so -2^2 evaluates to 4 (Excel).
          const operand = this.parseExpr(UNARY_BP);
          return { type: 'unary', op: '-', operand };
        }
        if (t.value === '+') return this.parseExpr(UNARY_BP);
        return { type: 'opaque', raw: t.value };
      case 'paren':
        if (t.value === '(') {
          const inner = this.parseExpr(0);
          if (this.peek()?.value === ')') this.next();
          return inner;
        }
        return { type: 'opaque', raw: t.value };
      case 'array':
      case 'structured':
      case 'external':
        return { type: 'opaque', raw: t.value };
      default:
        return { type: 'opaque', raw: t.value };
    }
  }

  private parseCall(name: string): Node {
    const args: Node[] = [];
    // current token should be '(' consumed as part of function token value
    if (this.peek()?.value === ')') {
      this.next();
      return { type: 'call', name, args };
    }
    for (;;) {
      args.push(this.parseExpr(0));
      const t = this.peek();
      if (t?.type === 'separator') {
        this.next();
        continue;
      }
      if (t?.value === ')') {
        this.next();
        break;
      }
      break;
    }
    return { type: 'call', name, args };
  }
}

function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/""/g, '"');
  return s;
}

/** Parse formula text (without leading `=`) into an AST. */
export function parseFormula(formula: string): Node {
  return new Parser(tokenize(formula)).parse();
}
