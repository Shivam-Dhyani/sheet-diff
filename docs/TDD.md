# SheetLens — Technical Design Document (TDD)

| Field | Value |
|---|---|
| Covers | Web app **SheetLens** (repo `sheetlens`) and engine **`@shivam-dhyani/sheet-diff`** (repo `sheet-diff`) |
| Version / date | 1.0 · 2026-10-08 |
| Status | Phase 1: approved for build · Phase 2: outline only (§19) |
| Requirements | `docs/PRD.md` (IDs FR-*, BR-*, NFR-*, US-*, CHK-*) |
| Acceptance data | `docs/fixtures/compare/*`, `docs/fixtures/merge/*` (+ `expected.json`) |

---

## 1. Purpose and conventions
This document says **how** to build Phase 1. Rules for the implementer:
1. **Build only Phase 1.** Anything tagged [P2] in the PRD or listed in §19 is out of scope.
2. **Never invent a library API.** When a third-party function or option is named here, it describes the *required behaviour*. Check the installed version's types, source or official docs before using it. If it differs, implement the behaviour with the real API and record it in `docs/IMPLEMENTATION_NOTES.md`.
3. **Spikes first (§17, M1).** Four risky integrations are proven in small spikes before feature work. Each spike result is written to `docs/SPIKES.md` along with the fallback taken, if any.
4. TypeScript `strict` everywhere. No `any` in public APIs. Validate external input at boundaries.
5. Excel coordinates: rows and columns are **0-based internally**; A1 strings only at the edges (UI, file formats). Name variables `r`/`c` for 0-based and `row1`/`colLetter` for display.
6. Money and quantity values stay JavaScript `number` (IEEE double), as Excel stores them. Compare with tolerance (BR-C4); never round stored values.

---

## 2. Architecture overview

```
┌──────────────────────────── Browser (single origin, static site) ─────────────────────────────┐
│                                                                                               │
│  Main thread (React UI)                         Engine Worker (one per session)               │
│  ┌──────────────────────────┐   Comlink RPC     ┌───────────────────────────────────────────┐ │
│  │ Routes: / /compare /merge│ ◀──────────────▶  │ @shivam-dhyani/sheet-diff                 │ │
│  │ Zustand UI store         │  (transferables)  │  read: SheetJS CE ─▶ compact IR           │ │
│  │ DiffGrid (virtualized)   │                   │  decrypt: officecrypto-tool               │ │
│  │ Findings, Detail, Merge  │   row windows     │  compare: tables→keys→rows→cells          │ │
│  │ Privacy panel (net log)  │ ◀──────────────── │  checks: CHK-01…10                        │ │
│  └──────────┬───────────────┘                   │  merge3: plan → resolutions → changeset   │ │
│             │ IndexedDB (settings, templates)   │  patch: fflate + XML splicer (OOXML)      │ │
│             ▼                                   │  reports: ExcelJS (lazy), HTML template   │ │
│        Service worker (offline cache)           └───────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ static files only (HTML/JS/CSS/fonts/fixtures) from Cloudflare Pages · no API · no analytics
```

**Data flow (Compare):** File → `ArrayBuffer` (transferred to the worker) → detect format/encryption → (decrypt) → SheetJS parse (dense) → **IR** per sheet (then the SheetJS object is released) → pair sheets → detect tables → match columns → detect keys → match rows → compare cells → run checks → `CompareResult` summary sent to the UI. The grid pulls **row windows** on demand.

**Data flow (Merge):** three IRs → compare(base, A) and compare(base, B) → merge plan (proposals + conflicts) → user resolutions → change set → impact preview (evaluator) → **patch** the Original's bytes → self-check (re-read and diff) → (re-encrypt) → download.

---

## 3. Architecture decisions (ADRs)
| ADR | Decision | Alternatives considered | Why | Consequences |
|---|---|---|---|---|
| ADR-01 | **All processing in the browser**; static hosting | Server-side processing | Privacy promise (G-3), ₹0 cost, no data liability | Bounded by device memory → §13; no sharing in P1 |
| ADR-02 | **Engine is a separate pure-TS package**, hosted in a Web Worker, called via Comlink | Engine inside the app; WASM engine | Reuse (CLI, Node tests, npm); keeps the UI thread free; portfolio value | Must avoid DOM APIs in the engine; a clean API boundary |
| ADR-03 | **Read with SheetJS CE** (dense mode) | ExcelJS read; custom OOXML reader | Fastest broad-format reader, including .xls/.csv | CE doesn't write styles → reports use ExcelJS; formatting read is partial (only number formats used in P1) |
| ADR-04 | **Own compact IR** (columnar typed arrays + interned strings) | Keep SheetJS objects | 5–10× lower memory at 100k+ rows | Conversion step; IR is the only model the engine uses |
| ADR-05 | **Key-based join first; Myers sequence diff fallback** with similarity pairing | Pure LCS; cell-address compare | Keys handle inserts and re-sorts exactly in O(n); LCS O(n·m) can't scale | Key detection quality is critical → BR-C1, tests |
| ADR-06 | **Formula comparison through reference translation** using row/column maps | Text compare; R1C1 text only | Excel rewrites ranges on insert/delete; text compare gives false changes (BR-C3) | Needs a real tokenizer (§11) |
| ADR-07 | **Own small formula evaluator** + `@formulajs/formulajs` functions (MIT) | HyperFormula | HyperFormula is GPLv3/commercial, which conflicts with an MIT package (D-11) | Only common functions are evaluated; the rest show "updates in Excel" |
| ADR-08 | **Patch-mode merge output** (edit XML inside the original zip) | Rebuild the workbook with a library | Rebuilding loses charts, pivots, macros and styles (FR-MRG-08) | Complex writer (§10) + self-check + unsafe operations blocked |
| ADR-09 | **Vite + React 19 SPA, React Router v7, landing page prerendered** | Next.js | No server needed; first-class workers; the prerendered landing page keeps SEO for "compare excel files" | Verify React Router's prerender/SPA mode in spike S4 |
| ADR-10 | **Large data lives only in the worker**; the UI pulls windows | Ship the whole result to the main thread | Avoids structured-clone cost and doubled memory | Needs a window API + small LRU cache in the UI |
| ADR-11 | **IndexedDB (Dexie) for settings/templates only** | localStorage | Structured data, async, larger | Never stores file content (FR-PRV-04) |
| ADR-12 | **PWA (vite-plugin-pwa / Workbox)**, precache everything | No offline | FR-PRV-03; strengthens the privacy proof | Update prompt UX |
| ADR-13 | **No telemetry**; a "Copy diagnostic info" button for user-initiated bug reports (no file data) | Sentry etc. | D-07 privacy | Bugs reported manually |
| ADR-14 | **Cloudflare Pages** for hosting | Vercel Hobby, Netlify Free, GitHub Pages | Free tier with **unlimited static bandwidth/requests**, 500 builds/month, `_headers` for CSP, preview deploys per PR. Vercel Hobby is for **personal, non-commercial use only** (100 GB transfer). Netlify Free is now **credit-based (300 credits/month) and pauses the site** when credits run out. GitHub Pages can't set custom headers (no CSP) | Static output, so switching hosts later means only redeploying `dist/` plus the headers file |
| ADR-15 | **Daily project logs** (`logs/YYYY-MM-DD.md`, append-only, `merge=union`) | Commit messages only; a single CHANGELOG | Gives every developer's Claude the context of earlier changes before it edits (CLAUDE.md "Project logs") | A small writing cost per task; logs are committed with the code |

---

## 4. Technology stack and dependencies
Use the latest stable version of each at implementation time; record exact versions in `docs/VERSIONS.md`. Licences must be MIT/BSD/Apache-2.0/ISC (D-11).

| Area | Choice | Notes |
|---|---|---|
| Language/tooling | TypeScript (strict), pnpm, ESLint, Prettier | Node Active LTS for tooling |
| Excel read | **SheetJS Community Edition** (`xlsx`) | Its docs say to install from the **SheetJS CDN tarball**, because the npm-registry version is outdated. Follow its current install docs. Options used: `dense`, `cellFormula`, `cellNF`, `cellDates: false` |
| Decryption / re-encryption | **`officecrypto-tool`** (MIT) | Lists Agile/Standard decryption for .xlsx, XOR/RC4 (experimental) for .xls, encryption for .xlsx. Browser support is proven in spike S1. Fallback: implement ECMA-376 Agile decryption with WebCrypto + the `cfb` package (MIT) |
| Zip | **`fflate`** | Unzip/zip in the worker for the patch writer and feature detection |
| Report writing | **ExcelJS** | Lazy-loaded only on export (large bundle); runs in the worker (verified in S4; fallback: main thread) |
| Sequence diff | **`diff-sequences`** (MIT, Myers) or equivalent | Behind the `SequenceDiff` interface |
| Formula functions | **`@formulajs/formulajs`** | Function implementations only; the parser/evaluator is our own (§11) |
| Worker RPC | **Comlink** | |
| UI | React 19, React Router v7, Zustand, **@tanstack/react-virtual**, CSS Modules + CSS custom properties | No CSS-in-JS runtime |
| Storage | **Dexie** (IndexedDB) | |
| PWA | **vite-plugin-pwa** | |
| Testing | Vitest, Testing Library, **fast-check** (property tests), Playwright (+ `@axe-core/playwright`), LibreOffice headless in CI | |
| Hosting | Cloudflare Pages (free) | `_headers` file for CSP |

---

## 5. Repositories and structure

### 5.1 `sheet-diff` (engine package)
```
sheet-diff/
  src/
    index.ts                 # public API (§6.3)
    ir/                      # compact workbook model
      workbook.ts  sheet.ts  string-pool.ts  types.ts
    read/
      detect.ts              # format + encryption sniffing
      decrypt.ts             # officecrypto-tool wrapper (or WebCrypto fallback)
      sheetjs-adapter.ts     # SheetJS → IR
      csv.ts                 # delimiter/encoding detection
      features.ts            # charts/pivots/macros/tables/comments inventory (zip listing)
    table/                   # header + data range + total rows
    match/
      sheets.ts  columns.ts  keys.ts  rows-key.ts  rows-order.ts  similarity.ts  hash.ts
    compare/
      cells.ts  normalize.ts  result.ts  positional.ts
    formula/
      tokenizer.ts  refs.ts  translate.ts  parser.ts  evaluator.ts  functions.ts
    checks/
      index.ts  chk01-overwritten.ts … chk10-india-ids.ts  messages.ts
    merge/
      plan.ts  resolve.ts  changeset.ts  impact.ts  log.ts
    patch/
      zip.ts  parts.ts  xml-splicer.ts  cells.ts  rows.ts  formulas.ts  merge-log-sheet.ts
      calc.ts  blockers.ts  csv-writer.ts  selfcheck.ts  encrypt.ts
    report/                  # report DATA model only (rendering lives in the app)
  bin/cli.ts
  test/ (unit) · golden/ (uses fixtures) · gen/ (pair generator) · bench/
  README.md  LICENSE  package.json  tsconfig.json  tsup.config.ts
```
Build with `tsup` → ESM + CJS + `.d.ts`. `exports` map with `"."`, `"./cli"`. No DOM types in `tsconfig` lib.

### 5.2 `sheetlens` (web app)
```
sheetlens/
  CLAUDE.md   .gitattributes (logs merge=union)
  logs/ (README.md + one YYYY-MM-DD.md per working day; see CLAUDE.md)
  docs/ (PRD.md, TDD.md, fixtures/, VERSIONS.md, IMPLEMENTATION_NOTES.md, SPIKES.md)
  public/ (_headers, fonts/, samples/ ← copy of docs/fixtures xlsx files, icons/)
  src/
    main.tsx  routes.tsx
    worker/engine.worker.ts  worker/client.ts      # Comlink wrapper + crash watchdog
    reports/excel-report.ts  reports/html-report.ts  reports/copy-summary.ts
    store/session.ts  store/settings.ts             # Zustand
    db/dexie.ts                                     # settings, templates
    features/
      landing/  intake/ (DropZone, PasswordDialog)  setup/  results/ (Headline, SummaryCards,
      FindingsList, DetailPanel, SheetTabs, DiffGrid/, ChangeCards, ExportMenu)
      merge/ (MergeBoard, ConflictCard, ProposalList, ImpactPanel, FidelityChecklist)
      privacy/ (PrivacyPanel, NetworkLog)  settings/
    ui/ (Button, Dialog, Tabs, Toast, Icon…)  styles/tokens.css
    lib/format.ts (Indian number/date formatting)  lib/filename-pattern.ts
  e2e/ (Playwright specs)  vite.config.ts  package.json
```
During development the app depends on the engine through a workspace link. Production builds use the published `0.x` version.

---

## 6. Engine domain model and public API

### 6.1 Compact IR
```ts
type CellKind = 0 /*empty*/ | 1 /*number*/ | 2 /*string*/ | 3 /*boolean*/ | 4 /*error*/ | 5 /*date-serial*/;

interface SheetIR {
  name: string;
  rows: number; cols: number;                 // used range size (0-based bounds)
  kind: Uint8Array;                           // rows*cols, row-major
  num: Float64Array;                          // numbers/booleans/date serials (NaN otherwise)
  str: Uint32Array;                           // string pool id (0 = none); also error text
  formula: Map<number, number>;               // cellIndex → formula pool id (text without '=')
  numFmt: Map<number, number> | null;         // cellIndex → format pool id (only if requested)
  merges: Array<[r1:number,c1:number,r2:number,c2:number]>;
}
interface WorkbookIR {
  fileName: string; format: 'xlsx'|'xlsm'|'xls'|'csv';
  date1904: boolean;
  pool: StringPool;                           // shared by all sheets (interning)
  sheets: SheetIR[];
  meta: { lastModifiedBy?: string; modified?: string };   // docProps/core.xml (used in P2)
  features: FeatureInventory;                 // §6.2
  sourceBytes?: Uint8Array;                   // kept only for the merge Original (patching)
}
```
Memory at 100k × 20 = 2 M cells: kind 2 MB + num 16 MB + str 8 MB ≈ **26 MB**, plus formulas/strings. SheetJS's own sheet object is freed right after conversion (one sheet at a time), so peak memory ≈ one parsed sheet + the IR.

### 6.2 Feature inventory (xlsx/xlsm only, from the zip listing + light XML scans)
`{ charts: string[] (sheet names they reference), pivotSources: string[], tablesBySheet: Record<sheet, {name, ref}[]>, commentsBySheet: Record<sheet, number[] /*rows*/>, drawingsAnchorRows: Record<sheet, number[]>, hasMacros: boolean, externalLinks: number, extLstSqrefSheets: string[], arrayFormulaRows: Record<sheet, number[]> }`. Used for the merge fidelity checklist (FR-MRG-08) and the blockers (§10.5).

### 6.3 Public API (stable surface of `@shivam-dhyani/sheet-diff`)
```ts
readWorkbook(bytes: Uint8Array, opts: { fileName: string; password?: string;
  csv?: { delimiter?: string; encoding?: 'utf-8'|'windows-1252' };
  valuesOnly?: boolean; keepSourceBytes?: boolean; onProgress?: (p: Progress) => void;
  signal?: { aborted: boolean } }): Promise<WorkbookIR>;            // throws SheetDiffError (§18)

isEncrypted(bytes: Uint8Array): Promise<boolean>;

analyzePair(oldWb: WorkbookIR, newWb: WorkbookIR, opts?: Partial<CompareOptions>): PairAnalysis;
  // sheet pairs, tables, column matches, key suggestions + confidence (for Setup UI)

compareWorkbooks(oldWb, newWb, opts: CompareOptions): CompareResult;
runChecks(result: CompareResult, oldWb, newWb, opts?: CheckOptions): Finding[];   // also called inside compareWorkbooks

planMerge(base, a, b, opts: MergeOptions): MergePlan;
resolveMerge(plan: MergePlan, resolutions: Resolutions, opts: { extendTotals: boolean }): MergeChangeSet;
previewImpact(base, changeSet): ImpactRow[];
applyMergePatch(base: WorkbookIR /* with sourceBytes */, changeSet, opts: {
  sourceLabels: [string,string]; password?: string; now: Date }): Promise<PatchOutput>;
  // PatchOutput { bytes: Uint8Array; applied: LogRow[]; blocked: BlockedOp[]; fidelity: FidelityReport }

buildReportModel(result: CompareResult, oldWb, newWb): ReportModel;   // rendered by the app
```
`CompareOptions`: `{ sheetPairs?: Override[]; headerRow?: Record<pairId, number>; dataRange?: …; keys?: Record<pairId, string[] /*header names*/>; ignoreCase; ignoreSpaces; numericTolerance (0.01); textDatesEqual (true); compareNumberFormats (false); dateOrder: 'DMY' }`.

`CompareResult` (summary; heavy arrays stay in the worker):
```ts
{ pairs: SheetPairResult[]; findings: Finding[]; counts: Counts; positionalBaseline: Record<string, number>; durationMs: number }
SheetPairResult { id; oldName?; newName?; status: 'matched'|'renamed'|'added'|'removed';
  key: { columns: string[]; mode: 'key'|'composite'|'order'; confidence: 'high'|'medium'|'low'; duplicates: number };
  columns: ColumnMatch[]; rowMap: Int32Array /* old→new, -1 removed */; rowStatus: Uint8Array /* new rows + removed */;
  cellChanges: CellChange[]; totalsSection?: …; }
CellChange { pairId; key: string; column: string; kind: ChangeKind; oldCell?: CellRef; newCell?: CellRef;
  old: Scalar; new: Scalar; oldFormula?: string; newFormula?: string; flags: Flag[] }
Finding { id; rule: 'CHK-01'…'CHK-10'|'ROW_ADDED'|'ROW_REMOVED'|'CELL_EDIT'…; severity: 'high'|'medium'|'info';
  pairId?; key?; column?; cells?: string[]; title: string; message: string; data: Record<string, unknown> }
```
Determinism: every collection is sorted by (pair order, new row index, column index) before it is returned. IDs are stable hashes of (rule, pair, key, column).

---

## 7. Comparison pipeline and algorithms

### 7.1 Reading (`read/`)
1. **Sniff the format** from bytes: `PK\x03\x04` → OOXML (check `[Content_Types].xml` for the macro-enabled type → xlsm). `D0 CF 11 E0 A1 B1 1A E1` (CFB) → either **encrypted OOXML** (contains `EncryptionInfo` + `EncryptedPackage` streams) or **.xls** (BIFF; may contain a `FILEPASS` record → encrypted). Otherwise → CSV/text.
2. **Encrypted** → `PASSWORD_REQUIRED` unless a password was given → decrypt (§4) → continue with the decrypted bytes. A wrong password → `PASSWORD_WRONG`. An unsupported scheme → `ENCRYPTION_UNSUPPORTED`. The password is held only in a local variable and never stored or logged.
3. **CSV**: encoding: BOM → UTF-8; else try UTF-8 strict decode → on failure Windows-1252. Delimiter: score `,`, `;`, `\t`, `|` by consistency of field counts over the first 50 lines (mode count > 1 and lowest variance wins). Parse RFC 4180 quoting. Values: numbers parsed only if the full text matches a numeric pattern (accept `1,23,456.78` Indian grouping and `123,456.78`; reject leading zeros like `00123` → text). Dates stay text (handled by BR-C5).
4. **SheetJS parse** with `dense: true, cellFormula: !valuesOnly, cellNF: compareNumberFormats, cellDates: false`. Convert **one sheet at a time** into `SheetIR`, interning strings into the shared pool, then drop the reference to the SheetJS sheet. Report progress per sheet and per 10k rows.
5. Formula text: store without the leading `=`. SheetJS's representation of shared formulas must be verified (S3): every cell must end up with its own complete formula text in the IR.
6. **Features** (§6.2): list zip entries with fflate (no full inflate) and scan the small XML parts (`xl/workbook.xml`, sheet rels, `xl/tables/*`, `xl/pivotCache/*`, `xl/charts/*`, `xl/drawings/*`) with regexes for the needed attributes.
7. **Guards**: abort if the total uncompressed size > 1.5 GB or the part count > 10,000 (zip-bomb guard), with `FILE_TOO_LARGE`.

### 7.2 Table detection (`table/`)
For each sheet:
- **Header row**: for r in 0..min(29, rows-1): `score(r) = textCells(r) * distinctRatio(r) * followConsistency(r)`, where `textCells` ≥ 2 is required, the text/non-empty ratio must be ≥ 0.6, and `followConsistency` = share of the header's columns that are non-empty in at least 2 of the next 3 rows. Pick the highest score; ties → the earliest row. None qualifies → header-less table: columns named "Column A…" and data starting at the first non-empty row.
- **Columns** = non-empty header cells, plus columns with data in ≥ 20 % of data rows (named "Column X").
- **Data range** = header+1 until two consecutive empty rows (all table columns empty) or a **total row** (BR-C8: first non-empty cell text matches `/^(grand\s+)?(sub\s*)?total\b/i`). Total rows form a `totalsSection`, compared by label.
- Overrides from Setup replace detection.
- Fixture check: "Sales Register" header row = row 4 (1-based), data rows 5–33/34; "Summary" header row 3, data rows 4–9.

### 7.3 Sheet pairing (`match/sheets.ts`)
1. Exact name → 2. case/space-insensitive name → 3. content similarity for the rest: `0.6 × Jaccard(normalized header sets) + 0.4 × overlap(row-hash samples of up to 200 rows)`; pair greedily by score ≥ 0.6 → status `renamed`. Unpaired → `added` / `removed` (CHK-09).

### 7.4 Column matching (`match/columns.ts`)
Normalize a header: lowercase, trim, collapse whitespace, strip `₹`, `(rs)`, `(rs.)`, `(inr)`, `(₹)` and punctuation. Exact matches first. For the remaining columns: candidate score = `max(JaroWinkler, tokenSetRatio)` × typeAgreement (same dominant cell kind → 1, else 0.7). Greedy pairing at score ≥ 0.85 → `renamed` column. Duplicate header names are disambiguated by occurrence order. Unmatched → added/removed columns (CHK-09). The result also yields a **column map** (old col → new col) used by formula translation (§11.3).

### 7.5 Key detection (`match/keys.ts`) (BR-C1)
For each matched column present in both tables: `fill = nonEmpty/rows`, `uniq = distinct/nonEmpty` (strings normalized per options; numbers exact).
`score = min(fillO, fillN) × min(uniqO, uniqN) + 0.05 × nameBonus − 0.3 × isDateCol − 0.3 × isDecimalCol`. `nameBonus` = 1 if the header matches `/\b(no\.?|number|id|code|ref|invoice|inv|bill|voucher|vch|employee|emp|gstin|pan|sku|order)\b/i`. A column qualifies if `fill ≥ 0.98 && uniq ≥ 0.98` in both. The best one wins → `confidence = high` if both 1.0, else `medium`.
**Composite**: take the top 8 columns by distinct ratio; try pairs, then triples; accept the first combination with uniqueness ≥ 0.99 in both (prefer fewer columns, then higher nameBonus sum) → `medium`.
No key → `mode: 'order'`, `confidence: low` → the UI opens Setup (FR-SET-06).
**Key values**: a string key is normalized (trim, case per option). Composite keys join with `\u001F`.
Fixture: "Invoice No" (high), "Particulars" (high).

### 7.6 Row matching
**Key mode** (`rows-key.ts`): `Map<key, number[]>` per side, pairing occurrences in order (BR-C2). Unpaired old → removed; unpaired new → added. Produces `rowMap: Int32Array` (old data row → new data row or −1). O(n).

**Order mode** (`rows-order.ts`) for tables without a key:
1. Hash each row (64-bit FNV-1a over normalized values of the *matched* columns, with a separator byte between cells).
2. Run the Myers diff on the hash sequences (`SequenceDiff` interface).
3. **Churn guard**: if the edit distance D > 0.4 × (N+M), or the diff exceeds a work budget of 5×10⁷ steps, switch to **multiset mode**: pair rows with equal hashes regardless of order (order-insensitive), and report "Rows are in a different order — choose a key column for best results".
4. **Similarity pairing**: inside each hunk (deleted block vs inserted block, both ≤ 2,000 rows; larger hunks are split into windows), compute similarity = equal cells / matched columns and greedily pair the highest ≥ 0.5 → `changed`. The rest are added/removed.
5. **Moved**: a deleted row and an inserted row elsewhere with identical hashes → `moved` (Info).

### 7.7 Cell comparison (`compare/cells.ts`)
For each matched row pair and matched column, get `{kind, value, formula, numFmt}` on both sides:

| Old | New | Result |
|---|---|---|
| formula F₀ | formula F₁ | `translate(F₀)` ≡ F₁ (§11.3)? → values equal (tolerance) ? none : **recalculated** · else **formula_changed** |
| formula | no formula | **formula_overwritten** (old/new values both recorded) |
| no formula | formula | **formula_added** |
| value | value | equal per BR-C4/BR-C5 → none · numeric-looking text ↔ number with equal value → **type_changed** · otherwise **value_changed** |

Then: `numFmt` differs and the option is on → **format_changed** (Info). Flags: CHK-06 (number stored as text) and CHK-08 (|Δ|/|old| ≥ 0.5 or a sign flip, inputs only).
Row status = `changed` if any change other than `recalculated` / `format_changed`.

Normalization: strings → NFC, then optional case-folding and whitespace collapsing. Numbers: `|a−b| ≤ tolerance`. Dates: serial ↔ text date via `dateOrder` (DMY by default; accepted formats in BR-C5). Errors compare by code.

### 7.8 Totals section and positional baseline
Totals rows are compared by label (same cell rules). **Positional baseline**: the count of cells that differ at the *same address* within the union of both data ranges. It's used only for the contrast line (FR-RES-01). Fixture: 89.

---

## 8. Risk checks (`checks/`)
Each rule implements `run(ctx) → Finding[]`, where `ctx` holds both IRs, pair results and the formula services. Messages come from templates in `messages.ts`; amounts use `formatINR` when the column header contains `₹|rs|amount|value|total|price|rate|tax|gst`.

| Rule | Algorithm | Message template |
|---|---|---|
| **CHK-01** | Every `formula_overwritten` change. If the old formula is evaluable on the *new* inputs (§11.4), include "formula gives {expected}" | **Title:** "Formula replaced by a typed number" · "Someone typed {new} over the formula in {column} for {key}. The formula gives {expected}{diffNote}. This cell will no longer update when other values change." |
| **CHK-02** | Find aggregate calls (`SUM, SUMIF, SUMIFS, COUNT, COUNTA, COUNTIF, COUNTIFS, AVERAGE, AVERAGEIF, AVERAGEIFS, MIN, MAX, SUBTOTAL, AGGREGATE, SUMPRODUCT`) with a range argument inside a detected table T (same sheet or cross-sheet), with columns ⊆ T's columns. Let the range span rows [a,b] and the table data rows [f,l]. Fire if `a ≤ f+1`, `f ≤ b < l`, and coverage `(b−max(a,f)+1)/(l−f+1) ≥ 0.5` → excluded rows (b, l]. Also check `a > f+1` → excluded leading rows. Group by (formula sheet, excluded key set) → **one finding listing all cells**. If the old file had the same exclusion → Medium "existing issue" | **Title:** "Totals don't include {n} row(s)" · "{keys} {is/are} below the range used by {count} total formula(s) on {sheet} ({cells}). {impactLine}" (impact = sum of excluded rows in the aggregated column(s), when computable) |
| **CHK-03** | Removed keys K (length ≥ 4, containing a letter or ≥ 4 digits). Scan all string cells of the new workbook outside each table's key column; exact normalized match → locations. One finding per removed key | **Title:** "Deleted, but referenced elsewhere" · "{key} was removed from {sheet} but still appears in {locations}. If both are filed, the same item may be counted or reduced twice." |
| **CHK-04** | A date column has ≥ 90 % of its non-empty cells as dates (real or BR-C5 text). Period = the month with ≥ 80 % of values in the new table (none → rule off). Fire for **changed or added** rows whose date month ≠ period | **Title:** "Date moved outside {periodName}" · "{key} is now dated {new} in a {periodName} {sheetNoun}. It may belong to another period, or the date is a typo." |
| **CHK-05** | ID column: header matches `/(gstin|pan|id|code|no\.?|number)/i` **or** ≥ 80 % of values match `/^[A-Z0-9\-\/]{6,}$/`. Name column: text, not ID-like. In the old file the dependency name→ID holds for ≥ 95 % of names with ≥ 2 rows. In the new file a name with > 1 distinct ID that had 1 in the old file → finding at the rows whose ID differs from the old one | **Title:** "{name} now has two {idHeader}s" · "{key} uses {newId}, while {name}'s other rows use {oldId}. This is probably a typo." |
| **CHK-06** | Numeric column (≥ 90 % numbers); a text cell parseable as a number → flag. A finding only if the cell is changed/added | "'{text}' is stored as text, so totals skip it." |
| **CHK-07** | Duplicate key groups present in new but not in old | "{key} appears {n} times." |
| **CHK-08** | Flag on numeric input changes (§7.7) | Tag "Large change" |
| **CHK-09** | Sheets/columns added/removed/renamed; sheets with `moved` rows (order mode) | "New sheet: {name}." / "Column renamed: {old} → {new}." |
| **CHK-10** | Columns with a header matching `/gstin/i` → `^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`; `/\bpan\b/i` → `^[A-Z]{5}[0-9]{4}[A-Z]$`. Changed/added cells only | "{value} is not a valid {GSTIN/PAN} format." |

Plus non-rule findings: `ROW_ADDED`, `ROW_REMOVED` (Medium), `CELL_EDIT` (Medium; value/formula/type changes), `RECALCULATED` (grouped, Info). **Ordering** per BR-C6. **Golden expectation:** `docs/fixtures/compare/expected.json` (checks, flags, mustNotFire).

---

## 9. Assisted merge engine (`merge/`)

### 9.1 Plan
1. `cmpA = compareWorkbooks(base, a)`, `cmpB = compareWorkbooks(base, b)`, using the **base's key** per pair (the same key is required in both; otherwise `MERGE_NO_KEY` for that pair).
2. Sheet/column structure differences → **STRUCTURE** conflicts (keep the Original's structure; listed).
3. Per key k in base ∪ added:
   - ΔA(k), ΔB(k) = input-cell changes (kinds `value_changed`, `type_changed`, `formula_changed`, `formula_overwritten`, `formula_added`). **Excluded:** `recalculated`, `format_changed` (BR-M1).
   - Row presence: base / A / B → classify:

| Base | A | B | Result |
|---|---|---|---|
| ✓ | ✓ | ✓ | ΔA only → proposals(A); ΔB only → proposals(B); both: same cell, same value → one proposal (both); **same cell, different value → CELL**; **different cells → RELATED_EDITS** (row level, includes all of ΔA and ΔB) |
| ✓ | ✗ | ✓ | ΔB empty → proposal *delete (A)*; ΔB non-empty → **DELETE_EDIT** |
| ✓ | ✗ | ✗ | proposal *delete (both)* |
| ✗ | ✓ | ✗ | proposal *insert (A)* after the anchor (below) |
| ✗ | ✓ | ✓ | rows identical → one insert (both); else **ADD_ADD** |

   - **Insert anchor**: the nearest preceding row in the *copy's* order whose key exists in base and isn't being deleted; none → before the first data row.
4. Output `MergePlan { proposals: Proposal[]; conflicts: Conflict[] }`, with stable IDs and default selections (proposals ticked).
5. Fixture expectation: 5 proposals, 3 conflicts (`docs/fixtures/merge/expected.json`). Summary formula range shifts in each copy are **not** changes (BR-C3).

### 9.2 Resolution → change set
`Resolutions` = `Map<conflictId, choice>` plus unticked proposal IDs. `resolveMerge` validates that every conflict is resolved (else `MERGE_UNRESOLVED`), then emits:
```ts
MergeChangeSet {
  cellEdits: { pairId; key; column; value?: Scalar; formula?: string; source: 'A'|'B'|'both'|'typed' }[];
  rowInserts: { pairId; afterKey: string|null; cells: Record<column, {value?: Scalar; formula?: string}>; source }[];
  rowDeletes: { pairId; key; source }[];
  extendRanges: { sheet; cell: string; from: string; to: string }[];   // only if extendTotals
}
```
Formulas from a copy's inserted row are stored **relative to that row** (offset form, §11.2) and re-anchored at the destination row in the patch step.
`extendTotals`: run CHK-02 on the virtual merged model (§9.3); for each finding, rewrite each listed formula's range end to the new last data row.

### 9.3 Virtual merged model and impact preview
Build an overlay over the base IR: an edited-cell map plus a row-order array for the affected table(s), with formula translation for inserted/deleted rows (§11.3). `previewImpact` = evaluate every **totals formula** (a formula outside the tables that references a table range) before and after → `ImpactRow { sheet, label (cell to its left or row header), cell, before, after | 'excel' }`. Fixture: Total GST payable 2,17,910.72 → 2,29,272.32 with the test resolution and extendTotals.

### 9.4 Merge Log rows
`{ #, Sheet, Row key, Column, Old value, New value, Source (copy name/both/typed), Decision ('auto' | 'resolved: …'), Note }`, in application order. Blocked operations appear with `Decision = 'blocked — do manually'`.

---

## 10. Patch writer (`patch/`), editing the original file safely

### 10.1 Principles
- **Change only what is needed**; every untouched zip entry is copied with identical content.
- No DOM/XML library re-serialization (it would drop namespaces, `mc:Ignorable` content and `extLst`). Instead, a **span-based XML splicer**: scan the XML text, find the exact character spans of `<row …>…</row>` and `<c …/>|<c …>…</c>` elements (attributes in any order, self-closing tags, entities), and apply splices back-to-front.
- **Self-check after writing** (§10.9). If it fails, nothing is downloaded.

### 10.2 Locating parts
`xl/workbook.xml` (`<sheets><sheet name r:id/>`) → `xl/_rels/workbook.xml.rels` → worksheet part path. `date1904` from `<workbookPr date1904="1">`. Styles and sharedStrings are never rewritten.

### 10.3 Cell edits (`cells.ts`)
- Find or create `<row r="N">` in ascending order (copy `s`/`customFormat`/`ht` from the nearest row above when creating), then find or create `<c r="REF">` in column order.
- **Number**: `<c r="H12" s="{kept}"><v>45</v></c>` (drop any `t`).
- **String**: inline string, `<c r s t="inlineStr"><is><t xml:space="preserve">{escaped}</t></is></c>` (avoids touching sharedStrings).
- **Boolean**: `t="b"`, `<v>1|0</v>`. **Date**: Excel serial (respect `date1904`), keep `s`.
- **Formula**: `<c r s><f>{escaped formula}</f><v>{computed}</v></c>`, where `<v>` is written only if the evaluator computed it (§10.7).
- `s` (style) is kept from the existing cell; for a new cell, take the `s` of the cell above in the same column.

### 10.4 Row insert/delete (`rows.ts`), when not blocked
Insert at row index p (shift ≥ p down) / delete row p (shift > p up):
1. Renumber `<row r>` and every `<c r>` on the sheet (process descending for insert).
2. Update refs on the sheet: `<dimension ref>`, `<mergeCells>`, `<conditionalFormatting sqref>` + its formulas, `<dataValidations sqref>` + its formulas, `<hyperlinks ref>`, `<autoFilter ref>`, `<sheetViews><selection activeCell sqref>`, `<rowBreaks>`.
3. **Every formula in the workbook** that references this sheet (all sheets' `<f>` texts, `definedName`s in `workbook.xml`) is rewritten with Excel's insert/delete semantics (§11.3), producing `#REF!` where Excel would.
4. **Shared formulas** (`<f t="shared" ref si>`): if a group's range intersects rows ≥ p, expand every member into an explicit `<f>` (the full text is in the IR) and remove the group attributes.
5. **Tables** (`xl/tables/*.xml`) on the sheet: if p is inside the table body → grow/shrink `ref` (and the table's `autoFilter ref`).
6. Inserted row content = the copy's cells (values + formulas re-anchored), styled from the destination neighbour row.
7. Remove `xl/calcChain.xml` plus its relationship and `[Content_Types].xml` override (Excel rebuilds it).

### 10.5 Blocked operations (FR-MRG-07)
A row insert/delete on sheet S at row p is **blocked** if any of these hold (cell edits still apply):
1. A **pivot cache** source (`xl/pivotCache/pivotCacheDefinition*.xml` `worksheetSource sheet=S`).
2. A **chart** series formula referencing S (`xl/charts/chart*.xml` `<c:f>` contains `S!`).
3. A **drawing** anchored on S at a row ≥ p (`xdr:from/xdr:row`).
4. **Comments / threaded comments / notes** on S at rows ≥ p.
5. `extLst` content on S containing `xm:sqref` or x14 references (newer conditional formats/validations).
6. **Array or data-table formulas** (`t="array"|"dataTable"`) on S at rows ≥ p.
7. p falls **outside** a table body while a table exists below p on S.
8. The sheet XML fails the splicer's structural validation.
Blocked operations go to `PatchOutput.blocked` and the Merge Log (FR-MRG-07).

### 10.6 Merge Log sheet (`merge-log-sheet.ts`)
- New part `xl/worksheets/sheet{max+1}.xml` with inline strings, a frozen header and column widths.
- `workbook.xml`: append `<sheet name="SheetLens Merge Log" sheetId="{max+1}" r:id="{new rId}"/>` (the name must be unique: add " (2)" etc. if needed).
- `workbook.xml.rels`: a worksheet relationship with a unique `rId`.
- `[Content_Types].xml`: an `Override` for the new part with the worksheet content type.
- `docProps/app.xml`: if `TitlesOfParts`/`HeadingPairs` exist, append the sheet name and increment the counts.

### 10.7 Recalculation and cached values (`calc.ts`)
- Set `<calcPr fullCalcOnLoad="1"/>` in `workbook.xml` (create `calcPr` if absent, else add/replace the attribute) so Excel recalculates on open.
- For every formula cell whose inputs may have changed (any formula on edited sheets, and formulas on other sheets referencing them): write the **evaluator's result** as `<v>` when computable; otherwise **remove `<v>`**. Viewers that don't recalculate then show a correct value or a blank, never a stale total.

### 10.8 Re-encryption and CSV
- Original encrypted and the toggle on → encrypt the output bytes with the same password (§4). Verified by the S1 spike + manual check.
- CSV Original → write the merged table with the original delimiter, encoding, line endings and quoting style (RFC 4180). The Merge Log becomes a second CSV file in a zip download.

### 10.9 Self-check (`selfcheck.ts`)
After patching: `readWorkbook(output)` → `compareWorkbooks(base, output)` with the same keys → the set of input changes must equal the applied change set (inserts, deletes, cell edits, extended ranges), and **no other changes**. A mismatch → `PATCH_SELFCHECK_FAILED`, no download, and a "Copy diagnostic info" offer. Fixture: must pass for the test resolution.

---

## 11. Formula subsystem (`formula/`)

### 11.1 Tokenizer
Tokens: whitespace · operators `+ - * / ^ & = <> < > <= >= %` · `( ) , ;` · string `"…"` (`""` escapes) · number (incl. exponent) · boolean · error (`#REF!`, `#N/A`, `#VALUE!`, `#DIV/0!`, `#NAME?`, `#NUM!`, `#NULL!`, `#SPILL!`, `#CALC!`) · **reference** · function name (incl. `_xlfn.`/`_xlws.` prefixes) · defined name · opaque tokens for structured refs (`Table1[[#This Row],[Col]]`), external refs (`[1]Sheet1!A1`, flagged) and array constants (`{1,2;3,4}`).
Reference grammar: optional sheet (`Name!` or `'Quoted ''name'''!`, plus 3D `Sheet1:Sheet3!`, which is opaque) then `$?COL$?ROW`, a range `X:Y`, a whole column `$?A:$?C`, or a whole row `$?1:$?5`.

### 11.2 Reference model and relative form
`Ref { sheet?: string; r1,c1,r2,c2: number; absR1,absC1,absR2,absC2: boolean; kind: 'cell'|'range'|'cols'|'rows' }`. The **relative form** of a formula replaces non-absolute parts with offsets from the host cell, so copies of the same formula on different rows are equal.

### 11.3 Translation (BR-C3 and patching)
Inputs: `RowMap` per referenced sheet (old row → new row, or −1 if deleted), derived from the table row matching plus **outside-table rows** (rows above the table keep their numbers; rows below shift by `newTableEnd − oldTableEnd`), and `ColMap` from column matching.
- Single cell: map the row and column; −1 → `#REF!`.
- Range rows [a,b]: new start = map(first surviving row ≥ a), new end = map(last surviving row ≤ b); none surviving → `#REF!`. Rows **inserted** between surviving rows are inside the translated range, exactly like Excel; rows appended after b's mapped row are outside (that's how CHK-02 cases arise).
- Whole-column/whole-row refs: columns/rows mapped; unchanged otherwise.
- The host cell is translated too (relative parts are computed against the host's new position).
Equivalence = token-by-token equality of the translated old formula and the new formula (whitespace ignored, function names case-insensitive, `_xlfn.` prefix ignored).
Fixture checks: compare/Summary (old 5:33 → 5:33, no change); merge/Ravi (5:33 → 5:32 after delete); merge/Priya (5:33 → 5:34 after insert).

### 11.4 Evaluator
Pratt parser over tokens → AST. **Excel precedence** (lowest → highest): comparison `= <> < > <= >=` → `&` → `+ -` → `* /` → `^` → `%` → **unary minus** (so `-2^2 = 4`, as Excel computes it) → reference operators.
Evaluation against an `EvalContext` (IR or merged overlay), with memoization and cycle detection (cycle → unknown). Values: number, string, boolean, error, range, **unknown** (propagates). Functions (P1): `SUM, SUMIF, SUMIFS, COUNT, COUNTA, COUNTBLANK, COUNTIF, COUNTIFS, AVERAGE, AVERAGEIF, AVERAGEIFS, MIN, MAX, ROUND, ROUNDUP, ROUNDDOWN, INT, ABS, IF, IFERROR, AND, OR, NOT, SUBTOTAL (function_num 1–11/101–111), SUMPRODUCT, VLOOKUP (exact match), INDEX, MATCH (0)`. Implementations use `@formulajs/formulajs` where they match Excel semantics; criteria parsing for the `*IF(S)` functions is our own (`">=100"`, `"<>"`, wildcards `* ? ~`). Anything else → unknown → "updates when opened in Excel".

---

## 12. Web application

### 12.1 Routes and screens
| Route | Screen | Notes |
|---|---|---|
| `/` | Landing: headline, mode tabs, drop zones, "Try with sample files", privacy badge | **Prerendered** HTML for SEO (title "SheetLens — Compare Excel files instantly, privately") |
| `/compare` | Setup (only on low confidence or on request) → Results | Redirects to `/` if there is no session |
| `/merge` | Merge board → Download | |
| `/privacy` | "How do I know?" + network log + airplane-mode guide | Also a slide-over panel from any screen |
| `/settings` | Number style, defaults, saved templates (list/delete), clear data | |
| `/about` | What it is, open-source engine link, limitations | |

### 12.2 Worker client (`worker/client.ts`)
- One worker per session. API (Comlink): `openFile(slot, buffer /*transfer*/, password?)`, `analyze()`, `compare(options)`, `getRowWindow(pairId, view, filter, start, count)`, `getFinding(id)`, `buildExcelReport()`/`buildHtmlReport()` → `ArrayBuffer` (transfer), `planMerge(names)`, `resolveMerge(res)`, `previewImpact()`, `buildMergedFile(opts)`.
- **Progress**: a Comlink-proxied callback, throttled to 10 updates/s.
- **Cancel**: a cooperative flag checked between chunks; hard cancel = `worker.terminate()` + a new worker.
- **Crash watchdog**: `error`/`messageerror` events or a non-responsive ping (3 s during heavy work is allowed; 30 s with no progress → treat as crash) → `OUT_OF_MEMORY_OR_CRASH` message (FR-IN-08), and a fresh worker.

### 12.3 State
Zustand `session` store: `{ mode, slots: {status, fileName, size, needsPassword}, progress, analysis (pairs, keys, confidence), result (counts, findings[], pairs meta), ui: {activePair, view: 'unified'|'side', filter: 'changed'|'all', selectedFindingId}, merge: {plan summary, resolutions, extendTotals, impact} }`. Large row data is **not** in the store (ADR-10). `settings` store mirrors Dexie.

### 12.4 Diff grid (`results/DiffGrid/`)
- **2-D virtualization** (TanStack Virtual for rows and columns), sticky header row and key column.
- Fixed row heights: 36 px (normal) / 52 px (a row containing an "old value" sub-line in unified view), known from row metadata so no measuring is needed.
- The window loader fetches 200 rows around the viewport and keeps an LRU of 20 windows; scrolling never blocks on the worker (placeholder cells until loaded).
- **Side-by-side**: two grids share one scroll controller; removed rows appear as gaps on the right, added rows as gaps on the left.
- **Accessibility**: `role="grid"` with `aria-rowcount`, `aria-colcount`, and `aria-rowindex`/`aria-colindex` on rendered cells; roving tabindex; `J`/`K` navigate findings (FR-RES-07).
- **Cell states** use text plus colour (FR-RES-05): added/removed/edited/high/recalculated, with labels in the status column and an icon in changed cells.

### 12.5 Reports
- **Excel report** (`excel-report.ts`, ExcelJS, runs in the worker): sheets Overview / All Changes / "{Sheet} (marked)" exactly as FR-REP-01, using the prototype as the visual reference (`docs/fixtures/compare/reference_report_prototype.xlsx`). Overview counts are **COUNTIF formulas** over All Changes. Any user text starting with `= + - @` is written as a **string cell** (never as a formula) to prevent formula injection.
- **HTML report** (`html-report.ts`): one file; inline CSS + a JSON data block + ~5 KB of vanilla JS (filter, search, expand); all text HTML-escaped; `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">`; print stylesheet (A4 landscape, repeating table headers, page breaks between sheets).
- **Copy summary**: ≤ 1,000 characters, High findings first, plain text.

### 12.6 Templates (`db/dexie.ts`, FR-SET-07)
Tables: `settings (id='default', …options)`, `templates (patternKey, patternLabel, pairs: [{oldName,newName}], keys: Record<sheetName,string[]>, headerRows, options, updatedAt)`.
Pattern key: lowercase the file name, strip the extension, replace digit runs and month names (`jan…dec`, `january…`) with `#`, collapse separators → e.g. `salary_sep_2026.xlsx` → `salary_#_#`. Offer the template when both files' pattern keys match a saved one.

### 12.7 PWA and offline
vite-plugin-pwa `generateSW`: precache all build assets (including lazy chunks and ExcelJS), fonts and `public/samples/*`; navigation fallback to `index.html`. On update: toast "A new version is available — Reload". Offline indicator in the header.

### 12.8 Privacy panel (FR-PRV-02)
`PerformanceObserver({ type: 'resource', buffered: true })` collects entries. At session start, record a marker timestamp; the panel lists entries after the marker (path, initiator type, size). It shows "0 requests since you added files" when that's the case. Includes the airplane-mode instructions.

### 12.9 Visual design
Tokens in `styles/tokens.css`. The direction follows the SheetLens comparison-screen mockup already shared with the owner: IBM Plex Sans/Mono (self-hosted), off-white ground `#F7F7F4`, ink `#17191E`, accent teal `#0E6B66`; High = orange family (`#FBE0CF` / `#7A2805`), Medium = amber (`#FCEBC0` / `#5C3F00`), Added = blue (`#DCE9FB` / `#133A6B`), Removed = grey with strikethrough. Touch targets ≥ 44 px. Respect `prefers-reduced-motion`.

### 12.10 Formatting (`lib/format.ts`)
`Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })` for Indian grouping (₹1,23,456.78); `'en-US'` grouping when International is chosen. Dates `DD-MMM-YYYY`. Percentages: whole numbers when exact.

---

## 13. Performance engineering (NFR-03, R-01)
| Technique | Where |
|---|---|
| Parse and convert one sheet at a time; release SheetJS objects | `read/` |
| Columnar typed arrays + interned strings (≈ 26 MB per 2 M cells) | IR |
| Row hashing (64-bit FNV-1a) for order mode, sheet similarity, dedupe | `match/` |
| O(n) key join; bounded Myers with churn guard and work budget | `match/` |
| Chunked loops yielding every ~50 ms with progress | everywhere heavy |
| **Values-only mode** (skip formulas/formats) offered after an out-of-memory error | read options |
| Pre-check: estimated memory = 12 × uncompressed sheet XML size; above 1.2 GB → "large file" path | `read/detect.ts` |
| Worker-only heavy data; windowed transfer to the UI | ADR-10 |
| Lazy chunks: parser + grid after drop; ExcelJS on export | app build |
| Benchmarks: `bench/` (Node) for 10k/100k/300k generated pairs; Playwright perf spec in Chromium/Firefox/WebKit | CI nightly |

Budgets (NFR-03): 10k×20 ≤ 3 s; 100k×20 ≤ 20 s; 300k×20 completes or fails gracefully; grid ≥ 50 fps median at 100k rows; landing JS ≤ 200 KB gzip.

---

## 14. Security and privacy
**Threat model and controls**
| Threat | Control |
|---|---|
| File data leaving the device (bug or dependency) | CSP `connect-src 'self'`; no third-party origins; Playwright network test (§15.4); dependency review |
| Malicious file: zip bomb | Size/part-count guards (§7.1) |
| Malicious file: XML entity expansion | Our splicer ignores DTDs (and rejects a part containing `<!DOCTYPE`); verify the reader's behaviour in S3 |
| XSS via cell text in UI/HTML report | React escaping; HTML report escapes all text; no `dangerouslySetInnerHTML` |
| Formula injection in reports | String cells only (§12.5) |
| Password exposure | Kept only in worker memory for the decrypt/re-encrypt call; never logged, stored or sent; cleared afterwards |
| Supply chain | Lockfile, Renovate, `npm audit` in CI; publish with provenance |

**Response headers** (`public/_headers` on Cloudflare Pages):
```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Cross-Origin-Opener-Policy: same-origin
```
If a library needs `'unsafe-eval'` (check ExcelJS/SheetJS in S4), prefer a build that doesn't. Otherwise allow it only on the worker script via a separate header rule, and document it.

---

## 15. Testing strategy

### 15.1 Unit tests (Vitest)
Tokenizer (≥ 150 cases, including quoted sheet names, `$`, whole columns, errors, structured refs), translation (insert/delete above/inside/below ranges, `#REF!` creation), evaluator (precedence, criteria, unknown propagation), key scoring, header detection, CSV sniffing, number/date normalization, each CHK rule, merge classification table (§9.1), XML splicer (self-closing, attribute order, entities, nested `<is>`), row shifting of every ref-bearing element.

### 15.2 Golden tests (fixtures)
- `golden/compare.test.ts`: `readWorkbook` both files → `compareWorkbooks` → assert that `docs/fixtures/compare/expected.json` is a **subset match** of the result (every expected item present with equal values; findings count by rule equal; `mustNotFire` rules absent).
- `golden/merge.test.ts`: plan equals `expected.json` (proposals, conflicts); apply `testResolution` → patch → (a) self-check passes; (b) **LibreOffice headless recalculation** of the output (`soffice --headless --convert-to xlsx` into a temp dir, then read cached values) gives `summaryAfterExcelRecalculates`; (c) row order excerpts and cell values equal; (d) the Merge Log has 8 rows.

### 15.3 Generated and property tests
- **Pair generator** (`test/gen/`): seeded random registers (5–50 columns incl. formulas and a totals sheet) with planted mutations: edit, insert, delete, move, re-sort, column insert/delete/rename, formula overwrite, totals-range skip, date out of period, ID typo, number-as-text, duplicate key. Emits `truth.json`.
- Metrics per change kind: precision and recall. **Targets**: ≥ 99.5 % (key mode), ≥ 98 % (order mode). PRs run 100 pairs; nightly runs 500.
- **Properties (fast-check)**: `compare(x, x)` → no changes; `compare(a, b)` added ≡ `compare(b, a)` removed; `planMerge(base, a, base)` → only proposals from A, no conflicts; patch → self-check always passes on generated merges without blockers.

### 15.4 End-to-end and cross-browser (Playwright: Chromium, Firefox, WebKit)
US-01…US-07 as specs (using `public/samples`), including: password flow (encrypted fixture created in spike S1 with password `sheetlens-test`), offline reload, keyboard navigation, mobile viewport (Pixel 7) change cards, and the **network test**: record all requests after the first file drop → only same-origin static assets (or none). Plus axe scans (0 serious/critical), the bundle-size check and performance specs (§13).

### 15.5 Manual Excel fidelity checklist (before each merge release)
In **Excel desktop (Windows and Mac)**, open patched outputs for: the merge fixture; a file with a chart; a pivot table; an Excel table (ListObject); conditional formatting; data validation; comments; an `.xlsm` with a macro; a password-protected original. For each: **no repair prompt** · totals updated after open · features intact · Merge Log present · blocked operations listed correctly. Record results in `docs/RELEASE_CHECKS.md`. The same files go through Google Sheets and LibreOffice as a sanity check.

### 15.6 UAT protocol (2–4 users, PRD SM-5)
30-minute session per user (video call with screen share; their files stay on their machine):
1. Five-minute intro, no training.
2. Task 1: compare their own two versions; think aloud.
3. Task 2: download the report and explain what they'd send to whom.
4. Task 3 (if relevant): merge two edited copies.
5. Questions: anything missed? anything wrong? usefulness 1–5, trust 1–5, "would you use it monthly?".

Record in `docs/UAT.md`: time to understand all changes, missed/false changes, quotes, issues (severity). Fix blockers before launch.

---

## 16. CI/CD and deployment
- **Engine repo (GitHub Actions)**: lint → typecheck → unit → golden (compare; merge including `apt-get install libreoffice-calc`) → generated (100) → build → publish on tag `v*` (`npm publish --provenance --access public`). Nightly: generated (500) + benchmarks.
- **App repo**: lint → typecheck → unit → build → Playwright (3 engines) → axe → bundle-size check → deploy to **Cloudflare Pages** (preview per PR, production on `main`).
- Versioning: SemVer; engine `0.x` until the Phase 1 launch.
- **Project logs**: both repos have a `logs/` folder and the same `.gitattributes` rule. A CI check (warning only) flags any PR that changes `src/` without touching a `logs/*.md` file.

---

## 17. Milestones (with spikes first)
| # | Milestone | Done when |
|---|---|---|
| M0 | Repos, CI, tooling, fixtures copied into `public/samples` and engine `golden/` | CI green on empty skeletons |
| **M1** | **Spikes** (2–3 days), results in `docs/SPIKES.md`: **S1** decrypt in a worker: Excel-made Agile .xlsx (create `fixtures/encrypted/agile.xlsx`, password `sheetlens-test`), Standard, .xls RC4; re-encrypt output → opens in Excel. **S2** patch writer minimum: one cell edit + one row insert on the merge fixture → opens in Excel with no repair. **S3** SheetJS: 100k-row parse time/memory in Chrome/Firefox/Safari; shared formula expansion; DTD behaviour. **S4** Vite + React Router prerender + worker + PWA + ExcelJS in a worker under the CSP, on Cloudflare Pages | Each spike: PASS or fallback chosen and documented. **Owner reviews before M2** |
| M2 | Engine: IR, read, tables, pairing, columns, keys, key-mode rows, cells, formula tokenizer + translation | `golden/compare` passes for cell changes and recalculated items |
| M3 | Engine: CHK-01…10, order mode, generator, properties, CLI, README | Full `golden/compare` passes; accuracy targets met |
| M4 | App: landing (prerendered), intake + password, worker client, setup, results (headline, cards, findings, detail, tabs, grid both views, mobile cards), settings, templates, privacy panel, PWA | US-01, 03, 04, 06, 07 pass in 3 engines |
| M5 | Reports: Excel, HTML, copy summary | US-02 passes; reports open cleanly |
| M6 | Merge: plan, resolutions, evaluator, impact, merge UI | Merge plan equals the fixture; UI flows |
| M7 | Patch writer complete (§10), Merge Log, calc, blockers, CSV, re-encryption, self-check | `golden/merge` (with LibreOffice) passes; manual checklist §15.5 100 % |
| M8 | Hardening: performance budgets, a11y, error catalogue, cross-browser polish, engine `0.x` publish | All NFRs met; CI green |
| M9 | UAT (§15.6) + launch | PRD SM-1…SM-6 met; owner sign-off |

---

## 18. Error catalogue
| Code | When | User message | Action offered |
|---|---|---|---|
| `UNSUPPORTED_TYPE` | Wrong extension/signature | "SheetLens reads .xlsx, .xlsm, .xls and .csv files." | Choose another file |
| `CORRUPT_FILE` | Parser failure | "This file couldn't be read. It may be damaged — try opening and re-saving it in Excel." | Retry |
| `PASSWORD_REQUIRED` | Encrypted | Password dialog | — |
| `PASSWORD_WRONG` | Decrypt failed | "That password didn't open the file. Try again." | Retry (3×) then guide |
| `ENCRYPTION_UNSUPPORTED` | Unknown scheme | "This file uses a protection type SheetLens can't open yet." | "Save an unprotected copy" steps |
| `FILE_TOO_LARGE` | Guards hit | "This file is too large to compare in a browser." | Values-only / fewer sheets |
| `OUT_OF_MEMORY_OR_CRASH` | Worker died | "Your browser ran out of memory reading this file." | Values-only / fewer sheets / laptop |
| `NO_COMMON_SHEETS` | Pairing found nothing | "These files don't look like versions of the same sheet." | Compare anyway / re-pair |
| `MERGE_NO_KEY` | No key for a pair | "To merge safely, SheetLens needs a column that identifies each row." | Choose columns |
| `MERGE_XLS` | .xls Original | "To merge, open the original in Excel and save it as .xlsx." | — |
| `MERGE_UNRESOLVED` | Download with open conflicts | "Resolve {n} conflict(s) to download." | Jump to conflict |
| `PATCH_SELFCHECK_FAILED` | §10.9 mismatch | "SheetLens couldn't write this file safely, so it didn't download it." | Copy diagnostic info |
| `REPORT_FAILED` | Export error | "The report couldn't be created." | Try HTML report / retry |

"Copy diagnostic info" contains: app/engine versions, browser, error code, stack trace, file *features* (sheet count, row counts, part list), and **never** cell values or file names.

---

## 19. Phase 2 technical outline (planned, not built now)
- **Version timeline**: generalize to N versions. Chain row maps v1→v2→…→vN using the same key. Per-cell history = a list of (version, value, kind). UI: a timeline strip, a cell-history popover, compare any two. Engine API: `compareSeries(workbooks[], opts)`.
- **"Changed by"**: read `docProps/core.xml` (`lastModifiedBy`, `modified`), already captured in `WorkbookIR.meta`. Show it per version and in the Merge Log (copy label plus saved-by).
- **Backend** (separate service; Node + Postgres on a free tier): passkey/magic-link accounts; template sync; **end-to-end-encrypted share links** (AES-GCM in the browser; the key stays in the URL fragment, which the server never sees; ciphertext stored with an expiry). Monthly mode keeps an encrypted previous version only with explicit consent.
- Formatting/chart/pivot diff, Tally/bank/payroll presets, GSTIN check digit, VBA diff, Drive import, rebuild-mode merge.

---

## 20. Assumptions and open technical risks
| Item | Status / mitigation |
|---|---|
| `officecrypto-tool` works in a worker without Node polyfills | Spike S1; fallback: WebCrypto + `cfb` implementation of ECMA-376 Agile |
| SheetJS expands shared formulas per cell | Spike S3; fallback: expand from the master formula with §11.3 translation |
| Excel accepts patched files (inline strings, removed calcChain, new sheet part) | Spike S2 + checklist §15.5 |
| ExcelJS runs in a worker under the strict CSP | Spike S4; fallback: generate the report on the main thread |
| LibreOffice headless available in CI for recalculation checks | Ubuntu runner apt package; if it's unavailable, run the check locally before release |
| Evaluator coverage on real files | Unknown functions degrade gracefully ("updates in Excel") |
