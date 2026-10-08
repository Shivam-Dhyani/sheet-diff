# @shivam-dhyani/sheet-diff

> Identity-aware, formula-aware comparison (and, soon, assisted three-way merge)
> for spreadsheets — the open-source engine behind **SheetLens**.

Most "diff" tools compare cells at the same address, so inserting one row makes
every row below look changed. `sheet-diff` instead **matches rows by identity**
(e.g. _Invoice No_), understands **formulas** (a formula that only recalculated
is not a "change"; a formula typed over with a number is a high-risk one), and
**explains changes in plain language, ranked by risk**.

It runs anywhere — Node ≥ 20 or a browser worker — with **no DOM dependency**,
and never sends your data anywhere.

- MIT licensed
- Reads `.xlsx`, `.xlsm`, `.xls`, `.csv` (and password-protected files when the
  optional decryptor is installed)
- Pre-1.0 (`0.x`): the compare API is stable; merge/patch and report-model APIs
  land in upcoming releases

## Install

```sh
npm install @shivam-dhyani/sheet-diff
# or: pnpm add @shivam-dhyani/sheet-diff
```

> **SheetJS note:** this package depends on SheetJS Community Edition (`xlsx`).
> See [`docs/IMPLEMENTATION_NOTES.md`](docs/IMPLEMENTATION_NOTES.md) for how the
> version is pinned and how to switch to the SheetJS CDN build for large-file
> performance.

## Quick start

```ts
import { readWorkbook, compareWorkbooks } from '@shivam-dhyani/sheet-diff';
import { readFile } from 'node:fs/promises';

const oldWb = await readWorkbook(new Uint8Array(await readFile('old.xlsx')), { fileName: 'old.xlsx' });
const newWb = await readWorkbook(new Uint8Array(await readFile('new.xlsx')), { fileName: 'new.xlsx' });

const result = compareWorkbooks(oldWb, newWb);

console.log(`${result.counts.realChanges} real changes — ${result.counts.needsAttention} need attention`);
for (const f of result.findings) {
  console.log(`[${f.rule}] ${f.severity}: ${f.message}`);
}
```

## CLI

```sh
npx @shivam-dhyani/sheet-diff old.xlsx new.xlsx
npx @shivam-dhyani/sheet-diff old.xlsx new.xlsx --json
npx @shivam-dhyani/sheet-diff old.xlsx new.xlsx --key "Invoice No"
```

Example output:

```
3 real change(s) found — 2 need your attention.
(A basic cell-by-cell compare would flag 8 cells.)

Needs attention (High):
  • [CHK-01] Someone typed ₹160 over the formula in Amount for INV-1003.
    The formula gives ₹150, not ₹160. This cell will no longer update…
  • [CHK-02] INV-1004 is below the range used by 1 total formula(s)…
```

## API

| Function | Purpose |
|---|---|
| `readWorkbook(bytes, opts)` | Parse bytes → compact in-memory model (IR). Throws `SheetDiffError` with a stable `code` on recoverable failures. |
| `isEncrypted(bytes)` | Detect a password-protected container. |
| `analyzePair(oldWb, newWb, opts?)` | Sheet pairs, column matches and key suggestions (for a Setup UI). |
| `compareWorkbooks(oldWb, newWb, opts?)` | Full comparison + risk checks → `CompareResult`. |
| `runChecks(result, oldWb, newWb, opts?)` | Re-run the risk checks standalone. |

`CompareResult` carries `counts`, a `findings` list (each with `rule`,
`severity`, `title`, `message`), per-sheet-pair results (row map, row status,
cell changes), and a `positionalBaseline` for the "a basic compare would flag N
cells" contrast line.

## How matching works

1. **Sheets** pair by exact name, then case/space-insensitive name, then content
   similarity (headers + sampled row hashes).
2. **Columns** match by normalized header, then fuzzy (Jaro-Winkler / token-set)
   with type agreement; renamed columns are detected.
3. **A key column** is suggested when a column is filled and unique in ≥ 98 % of
   rows in both files (preferring `No`/`ID`/`Invoice`/… headers, avoiding dates
   and decimals). Composite keys are tried next; otherwise rows match by order
   (Myers diff with a churn guard).
4. **Cells** compare formula-aware: a formula whose references merely shifted
   because rows moved is _unchanged_; a formula whose value changed because an
   input changed is _recalculated_ (not counted as a real change); a formula
   replaced by a typed value is flagged high-risk.

## Risk checks

`CHK-01` formula replaced by a typed value · `CHK-02` a total's range misses
rows · `CHK-03` a deleted row still referenced elsewhere · `CHK-04` a date moved
outside the file's period · `CHK-05` one name now maps to two IDs · `CHK-06`
number stored as text · `CHK-07` duplicate key introduced · `CHK-08` large
numeric change (flag) · `CHK-09` sheet/column added/removed/renamed · `CHK-10`
invalid GSTIN/PAN format.

## Limitations (this release)

- Assisted three-way **merge**, the **patch writer**, and the **report model**
  (TDD §9–§10, §6.3) are not yet implemented — they arrive in later increments.
- The evaluator covers the common Excel functions (SUM/SUMIF(S)/COUNT.../
  AVERAGE.../MIN/MAX/ROUND.../IF/IFERROR/AND/OR/NOT/SUBTOTAL/SUMPRODUCT/
  VLOOKUP/INDEX/MATCH). Anything else degrades gracefully to "updates in Excel".
- Password-protected files need the optional `officecrypto-tool` dependency.

## Privacy

Pure computation. No network calls, no telemetry, no DOM. Your spreadsheet data
never leaves the process.

## License

[MIT](LICENSE) © Shivam Dhyani
