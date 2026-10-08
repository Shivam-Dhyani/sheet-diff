# SheetLens — Product Requirements Document (PRD)

| Field | Value |
|---|---|
| Product | **SheetLens** · descriptor: **Compare Excel files** |
| Tagline | *See every hidden change in your spreadsheets.* |
| Engine | **`@shivam-dhyani/sheet-diff`** (open-source npm package, MIT) |
| Owner | Shivam Dhyani |
| Version / date | 1.0 · 2026-10-08 |
| Status | **Phase 1: approved for build** · **Phase 2: planned roadmap** |
| Companion docs | `docs/TDD.md` (technical design), `CLAUDE.md` (rules for Claude Code), `docs/fixtures/` (acceptance files) |

---

## 0. How to read this document
- Every requirement has an ID and a phase tag: **[P1]** = build now, **[P2]** = do **not** build now (roadmap only).
- **MUST** = mandatory · **SHOULD** = expected unless a documented reason exists · **MAY** = optional.
- **§15 Glossary** explains spreadsheet and accounting terms for readers who don't use Excel daily.
- `docs/fixtures/` contains real sample files and their **exact expected results**. They are the acceptance tests for comparison and merge.

---

## 1. Executive summary
Finance and operations teams exchange spreadsheets by email and WhatsApp. When a revised file arrives ("FINAL – small corrections"), nobody can tell what actually changed without checking row by row. Mistakes that cost money slip through:
- a formula overwritten with a typed number,
- totals that skip a newly added row,
- an invoice date moved into the next month,
- a one-character change in a customer's tax ID.

**SheetLens** compares two versions of a spreadsheet **in the browser, without uploading the files**:
- **Rows are matched by identity** (e.g., Invoice No), not by position, so one inserted row doesn't make everything look changed.
- **Changes are explained in plain language and ranked by risk.**
- **A clean report** can be downloaded and shared.
- **Merge:** combines two people's edited copies of one original safely. Rows edited by both people become conflicts, totals are recalculated rather than merged, and every change needs approval.

A working prototype on the sample files found **8 real changes and 4 high-risk problems**, where a basic cell-by-cell comparison flagged **89 cells** (`docs/fixtures/compare/`).

---

## 2. Problem statement and evidence

### 2.1 Who has the problem
Anyone who receives a revised spreadsheet from someone else and must act on it: file a tax return, pay salaries, approve a purchase, upload prices.

### 2.2 Why existing tools don't solve it
| Tool | What it does | Why it fails this user |
|---|---|---|
| Google Sheets version history / cell edit history | Tracks edits made **inside one shared Google Sheet** | The two versions are **separate files** from email/WhatsApp. Its cell history also misses inserted/deleted rows, formatting changes and formula-driven changes |
| Excel "Spreadsheet Compare" | Compares two workbooks | Ships only with **Microsoft 365 Apps for enterprise**; most Indian small firms and CA offices don't have it |
| xltrail | Git-based version control for Excel | Paid, built for teams using Git; not for a junior accountant |
| Free browser diff sites (e.g., WorkbookDiff) | Compare cells at the same address | One inserted row makes every row below look changed; no explanation of risk |
| Manual checking | Two windows side by side | Slow, and misses subtle errors under deadline pressure |

### 2.3 Real cost of the problem (examples from the sample files)
- A typed-over GST cell (₹1,063.80 instead of ₹1,036.80) **files wrong tax**, and the cell stops updating when inputs change.
- A total that skips a new row **under-reports GST by ₹10,206**.
- A deleted invoice *plus* a new credit note against it **reduces the same sale twice**.
- A date moved to 2 October **puts an invoice in the wrong month's return**.

---

## 3. Goals, non-goals and success measures

### 3.1 Product goals
| ID | Goal |
|---|---|
| G-1 | A user understands **every real change** between two files within **2 minutes** for a typical register (≤ 5,000 rows). |
| G-2 | SheetLens surfaces **high-risk mistakes** automatically, explained in plain language. |
| G-3 | **Zero file data leaves the device**, and the user can verify this. |
| G-4 | Two edited copies can be merged into one correct file **without silent overwrites**. |
| G-5 | The product costs **₹0/month** to run in Phase 1. |

### 3.2 Portfolio goals (owner)
- Show frontend depth: Web Workers, virtualized grids, offline PWA, accessibility.
- Show algorithm and engineering depth: row matching, formula-aware comparison, three-way merge, editing Excel's file format directly.
- Publish a reusable open-source engine (`@shivam-dhyani/sheet-diff`).

### 3.3 Non-goals (Phase 1)
Accounts, cloud storage, sharing links, analytics, real-time collaboration, editing spreadsheets inside SheetLens, comparing charts/pivots/macros (they are detected and listed only), non-English UI.

### 3.4 Success measures
No analytics in Phase 1 (decision D-07), so success is measured through acceptance tests and user acceptance testing (UAT).
| ID | Measure | Target |
|---|---|---|
| SM-1 | Sample-file results equal `docs/fixtures/*/expected.json` | Exact match |
| SM-2 | Generated test pairs: changes correctly detected | ≥ 99.5 % precision and recall per change type |
| SM-3 | Performance targets met (§11) | All met in Chrome; within 2× in other browsers |
| SM-4 | Merged files open in Excel desktop without a repair prompt | 100 % of acceptance files |
| SM-5 | UAT: **2–4 real users** compare their own files | All complete without help; **0 missed changes they knew about**; ≥ 2 say "I'd use this every month" |
| SM-6 | Network check: no requests carrying file data | 0 |

---

## 4. Personas
| ID | Persona | Situation | Frequency | Priority |
|---|---|---|---|---|
| PER-1 | **Rohan, 23, article assistant / junior accountant at a CA firm** | Clients send revised sales and purchase registers before GST/TDS deadlines | Several times a week; peaks before monthly GST due dates | **Primary** |
| PER-2 | **Neha, payroll executive** (150-person company) | Compares this month's salary sheet with last month's before paying salaries | Monthly, high stakes | Primary |
| PER-3 | **Amit, purchase executive** | Compares vendor price lists and revised quotations | Weekly | Secondary |
| PER-4 | **Kavita, MIS / finance executive** | Compares monthly Tally/ERP exports and budget versions; sometimes merges two teams' edits | Monthly | Secondary (merge user) |
| PER-5 | **Imran, e-commerce operations** | Compares product price and stock files before uploading to marketplaces | Weekly | Secondary |

**Jobs to be done**
- *"When a client sends a revised file, help me see exactly what changed, so I can file correctly and ask the right questions."*
- *"When two colleagues edit copies of the same file, help me combine their work without losing or doubling anything."*
- *"Before I forward a file, help me catch mistakes I'd be blamed for."*

**UAT recruitment (2–4 testers):** at least one PER-1 and one PER-2. If possible, add a PER-4 for merge. Recruit through the owner's network and LinkedIn. Each tester uses **their own real file pair**; the files never leave their device.

---

## 5. Decision log
| # | Decision | Value |
|---|---|---|
| D-01 | Product name | **SheetLens**, descriptor **"Compare Excel files"** (used in page title, landing headline and meta description for search) |
| D-02 | Engine | `@shivam-dhyani/sheet-diff`, separate public repo, npm, MIT |
| D-03 | Phase 1 architecture | **Browser-only**: static site, no backend, no accounts, no uploads |
| D-04 | Phase 1 formats | .xlsx, .xlsm (cell data), .xls, .csv, plus **password-protected** .xlsx/.xls (the user types the password; SheetLens never bypasses or removes protection) |
| D-05 | Merge | **Assisted three-way merge in Phase 1**, following the business rules in §7.6 |
| D-06 | Merge output | **Patch mode**: a copy of the Original with only the approved changes applied, so charts, pivots, formatting and macros stay untouched. Unsafe row operations are blocked with an explanation |
| D-07 | Analytics | **None** in Phase 1 |
| D-08 | Delivery approach | **Direct build** (no research phase). Technical risks are handled by early spikes and tests in the TDD |
| D-09 | Hosting | Cloudflare Pages free tier (`sheetlens.pages.dev` until a custom domain is bought) |
| D-10 | Locale | English UI; **Indian number format** (₹1,00,000) by default, switchable to international |
| D-11 | Licences | MIT-compatible dependencies only (excludes GPL engines such as HyperFormula) |
| D-12 | Phase 2 commitment | **Version timeline** (many versions, cell history) and **"Changed by"** (who saved which version), so the product grows into the "Lens" name |

---

## 6. Scope

### 6.1 Phase 1 [P1]
1. **Compare** two files: automatic sheet pairing, header and table detection, key detection (single or composite column), row matching with an order-based fallback, and formula-aware cell comparison.
2. **Risk checks** CHK-01…CHK-10 (§7.4).
3. **Results**: headline, summary cards, "Needs attention" list, detail panel, sheet tabs, virtualized grid (unified and side-by-side), filters, mobile change cards.
4. **Reports**: Excel report, self-contained HTML report (printable to PDF), and a "Copy summary" for WhatsApp/email.
5. **Assisted Merge**: Original + Copy 1 + Copy 2, conflict resolution, impact preview, patched output with a Merge Log sheet.
6. **Password-protected files** (open, and re-save merged output with the same password).
7. **Comparison settings and remembered templates** (settings only, never file contents).
8. **Offline after the first visit**, plus a visible "How do I know my files aren't uploaded?" panel.
9. **Built-in sample files** (the fixtures) for a first-time demo.
10. The **`@shivam-dhyani/sheet-diff`** package with a CLI.

### 6.2 Phase 2 roadmap [P2] (not built now)
| Order | Item |
|---|---|
| 1 | **Version timeline**: drop 3+ versions (v1, v2, FINAL), see each cell's history, and compare any two |
| 2 | **"Changed by"**: show who last saved each version (file metadata) and, in merges, which copy a change came from |
| 3 | **Backend & accounts**: saved templates across devices, end-to-end-encrypted share links (the key stays in the link, the server can't read the data) |
| 4 | **Monthly mode**: remembers last month's file; drop only the new export |
| 5 | Formatting diff (fonts, fills, borders, conditional formats) and chart/pivot change detection |
| 6 | Presets for Tally exports, bank statements and payroll formats |
| 7 | India pack v2: GSTIN check-digit and PAN validation |
| 8 | VBA (macro code) comparison for .xlsm |
| 9 | Google Drive / Google Sheets import |
| 10 | "Rebuild" merge output for files patch mode can't handle; Pro tier exploration |

### 6.3 Explicitly out of scope for Phase 1
Everything in 6.2, plus comparing more than two files in Compare mode, editing cells inside SheetLens, automatic fixes (except the opt-in "extend totals" during merge), PDF generation libraries (the browser prints the HTML report), and a browser extension.

---

## 7. Functional requirements

### 7.1 File intake: FR-IN
| ID | Ph | Requirement |
|---|---|---|
| FR-IN-01 | P1 | Home has two modes: **Compare** (slots: *Old file*, *New file*) and **Merge** (slots: *Original*, *Copy 1*, *Copy 2*). Slots accept drag-and-drop or a file picker. |
| FR-IN-02 | P1 | Accepted extensions: `.xlsx`, `.xlsm`, `.xls`, `.csv`. Anything else → "SheetLens reads .xlsx, .xlsm, .xls and .csv files." |
| FR-IN-03 | P1 | Files are read with the browser's File API. **No file content, file name or derived data may leave the device.** |
| FR-IN-04 | P1 | An encrypted file opens a password dialog: "This file is password-protected. Enter the password you use to open it — it stays on this device." Wrong password → "That password didn't open the file. Try again." After 3 failures, show the "save an unprotected copy" steps. |
| FR-IN-05 | P1 | If an encryption type isn't supported, explain that and show the "save an unprotected copy" steps. |
| FR-IN-06 | P1 | CSV: auto-detect the delimiter (`,` `;` tab `|`) and encoding (UTF-8, UTF-8 with BOM, Windows-1252), with manual override. |
| FR-IN-07 | P1 | Above **30 MB or 300,000 rows in a sheet**, warn: "This is a large file. It may take a minute and works best on a laptop." |
| FR-IN-08 | P1 | Reading shows progress ("Reading sheet 2 of 5…") and a **Cancel** button. If the browser runs out of memory, show a clear message with options (compare fewer sheets / values only), **never an empty result**. |
| FR-IN-09 | P1 | "Try with sample files" loads `docs/fixtures/compare` (Compare) or `docs/fixtures/merge` (Merge). |
| FR-IN-10 | P1 | Files in the same mode must be the same kind of data. If the sheets share no header names at all, warn: "These files don't look like versions of the same sheet. Compare anyway?" |

### 7.2 Setup: FR-SET
| ID | Ph | Requirement |
|---|---|---|
| FR-SET-01 | P1 | Sheets pair automatically, by the same name first and then by content similarity (shown as "renamed"). The user can re-pair or exclude sheets. Unpaired sheets are "added" or "removed". |
| FR-SET-02 | P1 | Per pair, SheetLens detects the **header row** and **data range** (stopping at blank rows and "Total" rows). The user can override both. |
| FR-SET-03 | P1 | SheetLens suggests a **key column** with a reason ("Invoice No is filled and unique in both files"). If none qualifies, it suggests a **composite key** (e.g., Date + Amount + Narration). If none works, it uses **order-based matching** and says so. |
| FR-SET-04 | P1 | Duplicate key values are reported: "7 duplicate Invoice Nos — matched in order of appearance". |
| FR-SET-05 | P1 | Options: ignore case, ignore extra spaces, numeric tolerance (default ₹0.01), treat text dates and real dates as equal, compare number formats (default off), number style Indian/International. |
| FR-SET-06 | P1 | **Auto mode** is the default: if detection is confident, results show immediately, with "Matched by Invoice No · Change" visible on the results screen. Setup opens only on low confidence or on request. |
| FR-SET-07 | P1 | **Templates:** settings are saved locally against a normalized file-name pattern (digits/dates removed), and offered next time: "Use your settings from last time?" |

### 7.3 Comparison behaviour: FR-CMP
| ID | Ph | Requirement |
|---|---|---|
| FR-CMP-01 | P1 | Row states: **added, removed, changed, moved** (order-based mode only), **unchanged**. |
| FR-CMP-02 | P1 | Cell change kinds: **edited value · formula changed · formula replaced by a typed value · formula added · type changed** (e.g., number → text) **· number format changed** (if enabled) **· recalculated** (formula unchanged; value changed because an input changed). |
| FR-CMP-03 | P1 | **Recalculated** cells are shown separately as "updated automatically" and are never counted as real changes. |
| FR-CMP-04 | P1 | Formula ranges that Excel adjusted automatically because rows were inserted or deleted are **not changes** (see BR-C3). |
| FR-CMP-05 | P1 | Columns match by header text, including close matches (shown as "renamed"). Added and removed columns are reported. |
| FR-CMP-06 | P1 | Results are deterministic: the same files and settings always give the same output. |

### 7.4 Risk checks: FR-CHK
Each finding has a severity, location, plain-language explanation and suggested action (wording templates in TDD §8).
| ID | Ph | Severity | Check | Example explanation |
|---|---|---|---|---|
| CHK-01 | P1 | High | Formula replaced by a typed value | "Someone typed ₹1,063.80 over the formula. The formula gives ₹1,036.80, and this cell will no longer update." |
| CHK-02 | P1 | High | A total's range misses rows of its table | "INV-1031 was added below the totals' range. GST payable is understated by ₹10,206." |
| CHK-03 | P1 | High | A removed row is referenced by new content | "INV-1019 was deleted and a credit note was added against it — the sale is reduced twice." |
| CHK-04 | P1 | High | A changed/added date is outside the file's period | "This invoice is now dated 02-Oct-2026 in a September register." |
| CHK-05 | P1 | Medium | One name now maps to two IDs | "Desai Traders now has two GSTINs. INV-1004 is probably a typo." |
| CHK-06 | P1 | Medium (flag) | Number stored as text in a numeric column | "'1,250' is text, so totals skip it." |
| CHK-07 | P1 | Medium | Duplicate key introduced | "INV-1040 appears twice." |
| CHK-08 | P1 | Flag | A numeric input changed by ≥ 50 % or flipped sign | Shown as a "Large change" tag on that change |
| CHK-09 | P1 | Info | Sheet/column added, removed or renamed | "New sheet: Credit Notes." |
| CHK-10 | P1 | Medium | India pack: GSTIN/PAN column value with invalid format | "24AAMFD6041L1Z is not a valid GSTIN format." |

### 7.5 Results and reports: FR-RES, FR-REP
| ID | Ph | Requirement |
|---|---|---|
| FR-RES-01 | P1 | Headline: "{n} real changes found — {h} need your attention", plus a contrast line: "A basic cell-by-cell compare would flag {p} cells." If nothing differs: "No differences — these files contain the same data." |
| FR-RES-02 | P1 | Summary cards: Needs attention · To review · Rows added · Rows removed · Cells edited by hand · Formulas overwritten. |
| FR-RES-03 | P1 | Findings list (High, then Medium, then Info). Selecting one opens the **detail panel** (Old / New / What it means) and scrolls the grid to it. |
| FR-RES-04 | P1 | Sheet tabs with badges. A grid with **Changed rows only / All rows**, **Unified** view (old value shown under the new one) and **Side by side** view (synced scrolling). |
| FR-RES-05 | P1 | Colour is never the only signal: every state also has a text label or icon. The palette is colour-blind-safe (blue/orange families), and text contrast is ≥ 4.5:1. |
| FR-RES-06 | P1 | Below 768 px width, the grid becomes **change cards** ("INV-1008 · Qty 90 → 45"). |
| FR-RES-07 | P1 | Keyboard: `J`/`K` or arrow keys for next/previous finding, `Enter` opens details; everything is reachable by Tab. |
| FR-RES-08 | P1 | Leaving the page with results open asks for confirmation (results aren't saved anywhere). |
| FR-REP-01 | P1 | **Excel report** with sheets **Overview** (counts as live formulas, attention list, effect on totals), **All Changes** (filterable, most important first) and **"{Sheet} (marked)"** per compared sheet (new layout; removed rows shown in place, struck through; changed cells highlighted with an "old value" note). The structure follows `docs/fixtures/compare/reference_report_prototype.xlsx`. |
| FR-REP-02 | P1 | **HTML report**: a single self-contained file (no external requests), filterable, with print styles so "Print → Save as PDF" gives a clean document. |
| FR-REP-03 | P1 | **Copy summary**: plain text for WhatsApp/email, e.g., "SheetLens: 8 changes, 4 need attention — 1) INV-1015 GST typed over formula…". |
| FR-REP-04 | P1 | Report file names: `SheetLens_{newFileName}_vs_{oldFileName}_{yyyy-mm-dd}.xlsx/.html`. |

### 7.6 Assisted Merge: FR-MRG and business rules
**Why this isn't Git merge:** spreadsheet cells are connected by meaning. Two "safe" edits in different cells can fix the same mistake twice. SheetLens therefore follows these rules:

| ID | Business rule |
|---|---|
| BR-M1 | **Formula cells are never merged as values.** They recalculate from merged inputs when the file opens. |
| BR-M2 | A cell changed by **one** person (or identically by both) is an **auto-proposal**, pre-ticked; the user can untick it. |
| BR-M3 | The **same cell** changed differently by both people → **CELL conflict**. |
| BR-M4 | **Different cells in the same row** changed by both people → **RELATED_EDITS conflict**. Accepting both requires an explicit acknowledgement. |
| BR-M5 | One person deleted a row the other edited → **DELETE_EDIT conflict**. |
| BR-M6 | Both added the same key with different content → **ADD_ADD conflict**. Identical additions merge into one row. |
| BR-M7 | Added, removed or renamed **columns or sheets** → **STRUCTURE conflict**. Phase 1 keeps the Original's structure and lists the difference. |
| BR-M8 | **Nothing is applied without being visible**: every applied change appears in the Merge Log with its source copy. |
| BR-M9 | A merge needs a **key column**. Without one, merge is unavailable, and the reason is explained. |

| ID | Ph | Requirement |
|---|---|---|
| FR-MRG-01 | P1 | Inputs: Original, Copy 1, Copy 2. The user names each copy (default "Copy 1"/"Copy 2"). |
| FR-MRG-02 | P1 | Screen: auto-proposals grouped by row, each tagged with its copy name; conflicts listed first, with a counter: "3 conflicts to resolve". |
| FR-MRG-03 | P1 | Resolution options: **CELL**: pick Copy 1 / Copy 2 / keep Original / type a value. **RELATED_EDITS**: Copy 1's edits / Copy 2's edits / keep Original / both (with the acknowledgement tick). **DELETE_EDIT**: delete / keep with edits / keep Original. **ADD_ADD**: pick one / keep both under different keys (user edits one key). |
| FR-MRG-04 | P1 | **Impact preview**: known totals before and after ("Total GST payable ₹2,17,910.72 → ₹2,29,272.32"). Totals the browser can't compute show "updates when opened in Excel". |
| FR-MRG-05 | P1 | Risk checks run on the **merged result**. For CHK-02, an opt-in **"Extend these totals to include the new rows"** lists the exact formulas that will change. |
| FR-MRG-06 | P1 | Output is a **patched copy of the Original**: approved cell changes are applied, new rows inserted at their position (after the same neighbour row as in the copy), deleted rows removed with formula ranges shrinking exactly as Excel would, a **"SheetLens Merge Log"** sheet added, and Excel recalculates all formulas when the file opens. |
| FR-MRG-07 | P1 | If an insert/delete can't be applied safely (pivot tables, charts, comments or tables that depend on the moved rows, see TDD §10.5), that operation is **blocked**: cell edits still apply, and the blocked rows are listed in the Merge Log and on screen for manual action. |
| FR-MRG-08 | P1 | **Fidelity checklist** before download, e.g., "Charts: kept · Pivot tables: kept · Macros: kept". The output keeps the Original's file type. |
| FR-MRG-09 | P1 | If the Original was password-protected, the output is saved **with the same password** by default (toggle: "Save without password"). |
| FR-MRG-10 | P1 | Supported Originals: **.xlsx, .xlsm** (patch mode), **.csv** (rewritten). **.xls**: "To merge, open the original in Excel and save it as .xlsx." |
| FR-MRG-11 | P1 | Output file name: `{OriginalName}_MERGED_{yyyy-mm-dd}.{ext}`. |

### 7.7 Privacy and offline: FR-PRV
| ID | Ph | Requirement |
|---|---|---|
| FR-PRV-01 | P1 | Strict Content-Security-Policy allowing network access only to the site itself; no third-party scripts, fonts or analytics. |
| FR-PRV-02 | P1 | **"How do I know?"** panel: explains the guarantee, shows a live list of network requests since files were added (expected: none), and suggests the airplane-mode test. |
| FR-PRV-03 | P1 | Works offline after the first visit (installable PWA). |
| FR-PRV-04 | P1 | Local storage holds only settings and templates, never file contents. "Clear all saved settings" is available in Settings. |

### 7.8 Engine package: FR-PKG
| ID | Ph | Requirement |
|---|---|---|
| FR-PKG-01 | P1 | Public API for reading, comparing, checking, merging and patching (TDD §6). No DOM dependency; runs in a browser worker and Node ≥ 20. |
| FR-PKG-02 | P1 | CLI: `npx @shivam-dhyani/sheet-diff old.xlsx new.xlsx [--json] [--key "Invoice No"]` and `… merge base.xlsx a.xlsx b.xlsx --json`. |
| FR-PKG-03 | P1 | README: install, quick start, API, how matching works, limitations, privacy note. |
| FR-PKG-04 | P1 | Published as `0.x` (pre-1.0) on npm. |

---

## 8. User stories and acceptance criteria (key flows)

**US-01 Compare revised client file (PER-1)**
*As Rohan, I want to drop the old and new register and see what changed, so I can file correctly.*
- **Given** the fixture pair, **when** I drop both files, **then** I see "8 real changes found — 4 need your attention" within 3 s, and the four High findings are CHK-01 (INV-1015), CHK-02 (INV-1031), CHK-03 (INV-1019) and CHK-04 (INV-1029).
- **Given** results, **when** I click INV-1015, **then** the detail panel shows Old "formula =I18*J18 → ₹1,036.80", New "typed ₹1,063.80" and the explanation.
- **Given** results, **when** I choose "Changed rows only", **then** exactly 8 rows show (5 changed, 2 added, 1 removed).

**US-02 Report for the client (PER-1)**
- **When** I click Download → Excel report, **then** a file downloads containing Overview, All Changes and Sales Register (marked), and it opens in Excel without errors.
- **When** I click Copy summary, **then** the clipboard holds a ≤ 1,000-character plain-text summary listing the High findings first.

**US-03 Password-protected file**
- **Given** an encrypted .xlsx, **when** I enter the correct password, **then** the comparison proceeds. **When** I enter a wrong one, **then** I see "That password didn't open the file. Try again." and nothing else happens.

**US-04 Monthly reuse (PER-2)**
- **Given** I compared `Salary_Aug.xlsx` and `Salary_Sep.xlsx` with key "Employee ID", **when** next month I drop `Salary_Sep.xlsx` and `Salary_Oct.xlsx`, **then** I'm asked "Use your settings from last time? (Key: Employee ID)".

**US-05 Merge two edited copies (PER-4)**
- **Given** the merge fixtures, **when** I drop Original, Ravi and Priya, **then** I see 5 auto-proposals and 3 conflicts (CELL INV-1003, RELATED_EDITS INV-1008, DELETE_EDIT INV-1019).
- **Given** I resolve them as in `expected.json → testResolution` and tick "Extend totals", **when** I download, **then** the file opens in Excel, shows 30 invoices, Summary "Total GST payable" = ₹2,29,272.32, and a "SheetLens Merge Log" sheet with 8 rows.
- **Given** an unresolved conflict, **then** the Download button is disabled and reads "Resolve 1 conflict to download".

**US-06 Trust the privacy promise**
- **When** I open "How do I know?" after comparing, **then** it shows "0 requests since you added files".
- **Given** I visited once, **when** I go offline and reload, **then** comparing the sample files still works.

**US-07 Large file**
- **Given** a 300,000-row file, **then** I see the large-file warning, a progress bar and Cancel. If the browser can't cope, I get a clear message instead of a blank page or crash.

---

## 9. Business rules: comparison
| ID | Rule |
|---|---|
| BR-C1 | **Key column suggestion**: a column qualifies if it's filled and unique in ≥ 98 % of rows in both files. Prefer headers like No/ID/Code/Invoice/Voucher/Employee/GSTIN/PAN. Avoid dates and decimals. |
| BR-C2 | **Duplicate keys** are matched in order of appearance and reported. |
| BR-C3 | A formula is "unchanged" if it equals the old formula after accounting for rows inserted/deleted in the sheets it refers to (Excel's automatic range adjustment). |
| BR-C4 | **Numbers** are equal if they differ by ≤ the tolerance (default 0.01). **Text** equality honours the ignore-case / ignore-spaces options. |
| BR-C5 | A text value that is a valid date (DD-MM-YYYY, DD/MM/YYYY, DD-Mon-YYYY, YYYY-MM-DD) equals the same real date when "treat text dates and real dates as equal" is on, and is then reported as "type changed" (Info), not "edited". |
| BR-C6 | **Severity order**: High → Medium → Info. Within a severity: rows with flags first, then by sheet order and row position. |
| BR-C7 | **"Real changes"** counts edited values, formula changes/overwrites/additions, type changes, and added and removed rows. Recalculated cells and Info items don't count. |
| BR-C8 | **Total rows** (first cell matching "Total", "Grand Total", "Sub Total", any case) are compared as their own section, matched by label, not as data rows. |
| BR-C9 | **Indian format**: amounts shown as ₹1,23,456.78 by default; percentages as whole numbers when exact (18 %). |

---

## 10. UI copy (key states)
| State | Text |
|---|---|
| Page title / meta | "SheetLens — Compare Excel files instantly, privately" |
| Landing headline | "See every hidden change in your spreadsheets." |
| Landing sub-line | "Compare two Excel files in seconds. Your files never leave this device." |
| Mode tabs | "Compare two files" · "Merge two edited copies" |
| Key in use | "Rows matched by **{column}** — filled and unique in both files. [Change]" |
| No key | "No column has a unique value in every row, so SheetLens matched rows by their order. Choose a key column for more reliable results. [Choose columns]" |
| Merge needs key | "To merge safely, SheetLens needs a column that identifies each row (like Invoice No). [Choose a column]" |
| Conflict counter | "{n} conflicts to resolve before download" |
| Related edits | "Ravi and Priya both changed this row. Their edits might be fixing the same thing — accepting both could double-correct it." |
| Blocked row move | "This file has a pivot table or chart that uses these rows, so SheetLens won't move rows. Add/delete these {n} rows in Excel — they're listed in the Merge Log." |
| Offline badge | "Works offline · Nothing uploaded" |

---

## 11. Non-functional requirements
| ID | Requirement |
|---|---|
| NFR-01 | **Cost**: ₹0/month (static hosting only). |
| NFR-02 | **Privacy**: no file data leaves the device; enforced by CSP and an automated network test. |
| NFR-03 | **Performance** (mid-range laptop, Chrome): 10k rows × 20 cols per file, read + compare **≤ 3 s**; 100k × 20 **≤ 20 s** without crashing; 300k × 20 completes or fails with a clear message; grid scrolling at 100k rows **≥ 50 fps** median; landing page JS **≤ 200 KB** gzipped. Other browsers: within 2× of Chrome. |
| NFR-04 | **Correctness first**: when unsure, report a change rather than hide it; never auto-resolve a conflict. |
| NFR-05 | **Browsers**: latest desktop Chrome, Edge, Firefox, Safari; Android Chrome for small files (≤ 5 MB) and viewing. |
| NFR-06 | **Accessibility**: WCAG 2.2 AA; complete keyboard support; labelled inputs; no colour-only meaning; respects reduced motion. |
| NFR-07 | **Reliability**: a crash while reading a file never takes down the page; the user can retry. |
| NFR-08 | **Fidelity**: merged output opens in Excel desktop without a repair prompt, and preserves charts, pivots, conditional formats, data validation and macros. |

---

## 12. Assumptions, constraints, dependencies
- **Assumption:** most target files are ≤ 50,000 rows per sheet and ≤ 20 MB.
- **Assumption:** users can download Google Sheets as .xlsx when needed.
- **Constraint:** no server, so no sharing links and no cross-device history in Phase 1.
- **Dependency:** open-source libraries for reading Excel files and for decrypting password-protected files (TDD §4). Their browser support is confirmed in an early spike (TDD §17, M1).

## 13. Risks
| ID | Risk | Mitigation |
|---|---|---|
| R-01 | Very large files exceed browser memory | Worker isolation, compact cell storage, warnings, values-only mode (TDD §13) |
| R-02 | The decryption library doesn't work in all browsers | Week-1 spike; fallback to "save an unprotected copy" guidance |
| R-03 | Patched merge files trigger Excel's repair prompt | Strict format rules, blocked unsafe operations, a manual Excel test checklist (TDD §15.5) |
| R-04 | False changes erode trust | Golden fixtures, generated-pair tests at ≥ 99.5 % accuracy |
| R-05 | Merge is used less than compare | Merge reuses the compare engine; its cost is mainly the patch writer, which also has portfolio value |
| R-06 | Users don't believe the privacy promise | Visible network log, offline mode, open-source engine |

## 14. Release plan
| Step | Content | Exit criteria |
|---|---|---|
| R1 — Engine alpha | Package: read, compare, checks, CLI | Fixtures pass; generated-pair accuracy ≥ 99.5 % |
| R2 — Compare beta | Web app: intake, password, results, reports, offline, privacy panel | US-01…04, 06, 07 pass on all four browsers |
| R3 — Merge beta | Merge engine, UI, patch writer | US-05 passes; manual Excel checklist 100 % |
| R4 — UAT | 2–4 real users with their own files | SM-5 met; issues triaged |
| R5 — Launch | Deploy on Cloudflare Pages, publish `sheet-diff` 0.x, LinkedIn post with demo video | Owner sign-off |

## 15. Glossary
| Term | Meaning |
|---|---|
| Workbook / sheet / cell | An Excel file / a tab in it / one box (e.g., H12 = column H, row 12) |
| Formula | A calculation in a cell, e.g., `=G5*H5` (Qty × Rate) |
| Cached value | The result Excel saved last time it calculated a formula; that's what other programs read |
| Recalculated | A formula cell whose result changed only because the cells it uses changed |
| Range | A block of cells, e.g., `I5:I33` = column I, rows 5–33; totals add up a range |
| Key column | A column whose value identifies each row uniquely (Invoice No, Employee ID) |
| Sales register | A list of all sales invoices for a period |
| GST / GSTR-1 | India's Goods and Services Tax / the monthly return that reports sales invoices |
| GSTIN | A 15-character GST registration number of a business |
| Credit note | A document that reduces an earlier invoice (e.g., goods returned) |
| CA / article assistant | Chartered Accountant / a trainee working at a CA firm |
| Tally | Accounting software widely used by Indian businesses; exports reports to Excel |
| .xlsx / .xlsm / .xls / .csv | Modern Excel / modern Excel with macros / old Excel (97–2003) / plain comma-separated text |
| Patch mode | Editing only the needed parts inside the original Excel file, so everything else stays byte-for-byte the same |
