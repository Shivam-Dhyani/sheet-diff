# Spikes (TDD §17 M1)

Four risky integrations proven before feature work. Record PASS or the fallback
taken.

| Spike | Goal | Status |
|---|---|---|
| S1 | Decrypt in a worker: Agile/Standard `.xlsx`, `.xls` RC4; re-encrypt output opens in Excel | **Pending** — `officecrypto-tool` wired behind `read/decrypt.ts` with `ENCRYPTION_UNSUPPORTED` fallback |
| S2 | Patch writer minimum: one cell edit + one row insert on the merge fixture → opens in Excel with no repair | **PASS** — the full merge fixture (5 edits + 1 delete + 2 inserts + extend-totals + Merge Log) patches and **recalculates correctly in LibreOffice headless** (golden test); real-desktop-Excel pass is the manual §15.5 check |
| S3 | SheetJS: 100k-row parse time/memory; shared-formula expansion; DTD behaviour | **Partial** — reader built against SheetJS dense mode; shared-formula expansion handled in `read/sheetjs-adapter.ts`; perf benchmarks to run in `bench/` |
| S4 | Vite + React Router prerender + worker + PWA + ExcelJS under CSP on Cloudflare Pages | **Pending** (app repo `sheet-lens`) |

> This engine increment covers the compare pipeline (M2/M3). Spikes S1, S2, S4
> are completed as their dependent features are built.

## Golden acceptance (TDD §15.2, SM-1)

The real compare fixture `docs/fixtures/compare/sales-register-sep2026`
(`Sales_Register_Sep2026_v1.xlsx` → `..._FINAL.xlsx`) now passes the golden
suite: **8 real changes, 4 high-risk** (CHK-01 INV-1015, CHK-02 INV-1031,
CHK-03 INV-1019, CHK-04 INV-1029), CHK-05 (Desai Traders), CHK-09 (Credit
Notes), the `mustNotFire` set (CHK-06/07/10) stays silent, the Summary reports
no real change (ranges cancel), and the positional baseline is exactly **89**
for the Sales Register. Fixing this against ground truth surfaced three bugs,
recorded in IMPLEMENTATION_NOTES.md (date-format detection without `XLSX.SSF`,
CHK-05 ID-column selection, positional baseline scoped to the data range).
