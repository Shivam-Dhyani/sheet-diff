# CLAUDE.md — `@shivam-dhyani/sheet-diff`

The open-source engine behind SheetLens. Pure TypeScript, no DOM, runs in Node
≥ 20 and in a browser worker.

## Ground rules (from `docs/TDD.md` §1)
1. **Build only Phase 1.** Anything tagged [P2] is out of scope.
2. **Never invent a library API.** When the TDD names a third-party function,
   it describes required behaviour — verify the installed version's real API and
   record any deviation in `docs/IMPLEMENTATION_NOTES.md`.
3. TypeScript `strict` everywhere; no `any` in public APIs; validate external
   input at boundaries.
4. Coordinates are **0-based internally**; A1 strings only at the edges
   (`src/ir/coords.ts`).
5. Money/quantity values stay JS `number`; compare with tolerance (BR-C4),
   never round stored values.

## Layout
- `src/ir` compact workbook model · `src/read` readers · `src/table` detection
- `src/match` sheet/column/key/row matching · `src/compare` pipeline
- `src/formula` tokenizer/refs/translate/parser/evaluator · `src/checks` CHK-01..10
- `bin/cli.ts` CLI · `test/` unit + properties + golden
- `src/merge`, `src/patch`, `src/report` — reserved for upcoming increments.

## Workflow
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before committing.
- Add a short entry to `logs/YYYY-MM-DD.md` for each meaningful change (ADR-15).
- Golden fixtures live in `docs/fixtures/`; `test/golden` skips until they exist.

## Status
Increment 1 shipped: the compare engine (read → compare → checks) + CLI.
Next: assisted merge (`src/merge`), patch writer (`src/patch`), report model.
