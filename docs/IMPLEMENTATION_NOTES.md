# Implementation notes

Deviations from the TDD, and places where a named library API differed from the
TDD's description (TDD §1 rule 2). Keep this current.

## SheetJS install source (TDD §4)

The TDD says to install SheetJS CE from the **SheetJS CDN tarball**
(`https://cdn.sheetjs.com/...`) because the npm-registry build is outdated.

In this build environment the egress policy does not allow `cdn.sheetjs.com`
(the agent proxy returns a 403 policy denial), so the package is installed from
the npm registry as **`xlsx@0.18.5`** — the last CE version SheetJS published
there. The engine uses the stable read surface (`XLSX.read` with `cellFormula`,
`cellNF`, `cellDates: false`) plus the SheetJS `SSF` date-format helper, which
are identical between 0.18.5 and current CDN builds, so there is no behavioural
impact for Phase 1 compare.

### Dense vs sparse representation (important)

The TDD specifies **dense mode** (`dense: true`) for lower memory at 100k+ rows.
SheetJS 0.18.5's `read` does **not** produce the `'!data'` dense array that
0.20 (CDN) uses — with `dense: true` it instead attaches row arrays under
numeric keys on the worksheet object, which is awkward to consume. So the reader
currently calls `XLSX.read(..., { dense: false })` and the adapter
(`src/read/sheetjs-adapter.ts`) iterates the sparse, A1-addressed cells. The
adapter **also** handles the `'!data'` dense array, so when the dependency is
bumped to the SheetJS CDN build (0.20.x) the only change needed is flipping
`dense` back to `true` in the adapter — the dense branch is already in place and
exercised by the type system.

**Action for production / app repo:** when the deploy environment can reach
`cdn.sheetjs.com`, switch the dependency to the pinned CDN tarball
(`xlsx@0.20.x`), set `dense: true`, and re-run the golden + generated tests.
Record the version in `VERSIONS.md`. This restores the TDD's memory profile for
very large sheets.

## officecrypto-tool (TDD §4, decryption)

`officecrypto-tool` is declared as an **optional** dependency. It failed pnpm's
compatibility check in this environment and was excluded from the install. It is
not needed for the compare-only increment; decryption support (and its browser
viability) is spike **S1** and is wired through `src/read/decrypt.ts`, which
loads the module lazily and falls back to `ENCRYPTION_UNSUPPORTED` when it is
absent. The documented fallback (WebCrypto + `cfb` ECMA-376 Agile) is tracked
for the S1 spike.

## Internal coordinates

Per TDD §1 rule 5, all row/column indices in the engine are **0-based**; A1
strings appear only at the edges (CLI output, file formats, messages). Helpers
live in `src/ir/coords.ts`.
