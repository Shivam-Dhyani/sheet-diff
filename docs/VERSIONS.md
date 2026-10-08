# Pinned versions

Recorded at implementation time (TDD §4). Update when dependencies change.

| Area | Package | Version | Notes |
|---|---|---|---|
| Runtime | Node | 22.x (engine supports ≥ 20) | tooling |
| Package manager | pnpm | 10.28 | |
| Language | TypeScript | 5.9.x | strict |
| Excel read | `xlsx` (SheetJS CE) | 0.18.5 | from npm registry — see IMPLEMENTATION_NOTES.md (CDN blocked here) |
| Zip | `fflate` | 0.8.x | feature inventory / patch writer |
| Formula fns | `@formulajs/formulajs` | 4.x | function implementations only |
| Sequence diff | `diff-sequences` | 29.6.x | Myers, behind `SequenceDiff` |
| Decryption | `officecrypto-tool` | (optional) | excluded in this env; spike S1 |
| Build | `tsup` | 8.x | ESM + CJS + d.ts |
| Test | `vitest` | 2.1.x | |
| Property tests | `fast-check` | 3.23.x | |
| Lint | `eslint` + `typescript-eslint` | 9.x / 8.x | flat config |
