# Spikes (TDD §17 M1)

Four risky integrations proven before feature work. Record PASS or the fallback
taken.

| Spike | Goal | Status |
|---|---|---|
| S1 | Decrypt in a worker: Agile/Standard `.xlsx`, `.xls` RC4; re-encrypt output opens in Excel | **Pending** — `officecrypto-tool` wired behind `read/decrypt.ts` with `ENCRYPTION_UNSUPPORTED` fallback |
| S2 | Patch writer minimum: one cell edit + one row insert on the merge fixture → opens in Excel with no repair | **Pending** (merge increment M6/M7) |
| S3 | SheetJS: 100k-row parse time/memory; shared-formula expansion; DTD behaviour | **Partial** — reader built against SheetJS dense mode; shared-formula expansion handled in `read/sheetjs-adapter.ts`; perf benchmarks to run in `bench/` |
| S4 | Vite + React Router prerender + worker + PWA + ExcelJS under CSP on Cloudflare Pages | **Pending** (app repo `sheet-lens`) |

> This engine increment covers the compare pipeline (M2/M3). Spikes S1, S2, S4
> are completed as their dependent features are built.
