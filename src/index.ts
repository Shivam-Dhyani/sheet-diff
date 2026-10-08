/**
 * `@shivam-dhyani/sheet-diff` — identity-aware, formula-aware spreadsheet
 * comparison (and, in later releases, assisted three-way merge).
 *
 * Phase 1 increment 1 ships the compare engine (read → compare → checks).
 * The merge/patch and report-model APIs (TDD §6.3) arrive in later increments.
 */

export const VERSION = '0.1.0';

// Reading
export { readWorkbook, isEncrypted } from './read/index.js';

// Comparison + checks
export { analyzePair, compareWorkbooks, runChecks } from './compare/index.js';
export type { PairAnalysis, PairSetup } from './compare/index.js';

// Assisted merge (TDD §9). Patch writer (§10) arrives in a later increment.
export {
  planMerge,
  resolveMerge,
  previewImpact,
  buildMergeLog,
  mergeDiff,
  computeExtendRanges,
  isTypedCell,
} from './merge/index.js';
export type {
  MergePlan,
  Proposal,
  Conflict,
  ConflictType,
  MergeSource,
  Resolutions,
  ConflictResolution,
  CellResolution,
  RelatedResolution,
  DeleteEditResolution,
  MergeChangeSet,
  ChangeSetCellEdit,
  ChangeSetRowInsert,
  ChangeSetRowDelete,
  ChangeSetExtendRange,
  ImpactRow,
  MergeLogRow,
  CellEdit,
  RowCell,
  StructureDiff,
  MergeOptions,
  ResolveOptions,
} from './merge/index.js';

// Patch writer (TDD §10) — writes the merged .xlsx/.xlsm/.csv.
export { applyMergePatch } from './patch/index.js';
export type { PatchOutput, PatchOptions, BlockedOp, FidelityReport } from './patch/index.js';

// Options
export {
  DEFAULT_COMPARE_OPTIONS,
  DEFAULT_CHECK_OPTIONS,
  resolveCompareOptions,
} from './options.js';
export type {
  CompareOptions,
  CheckOptions,
  ReadOptions,
  Progress,
  AbortFlag,
  DateOrder,
  SheetPairOverride,
} from './options.js';

// Result model
export type {
  CompareResult,
  SheetPairResult,
  CellChange,
  ChangeKind,
  Flag,
  Finding,
  CheckRule,
  Severity,
  Counts,
  ColumnMatch,
  KeyInfo,
  KeyMode,
  Confidence,
  TotalsSection,
  Scalar,
  CellRef,
} from './types.js';
export { RowState } from './types.js';

// IR
export type { WorkbookIR, SheetIR, FeatureInventory, Cell, StringPool } from './ir/types.js';
export { CellKind } from './ir/types.js';
export { getCell } from './ir/sheet.js';
export { rcToA1, a1ToRc, colToLetter, letterToCol } from './ir/coords.js';

// Errors
export { SheetDiffError, isSheetDiffError } from './errors.js';
export type { SheetDiffErrorCode } from './errors.js';

// Formula subsystem (useful for advanced consumers / tests)
export { tokenize } from './formula/tokenizer.js';
export { parseFormula } from './formula/parser.js';
export { evaluateFormula } from './formula/evaluator.js';
export { parseRef, refToString } from './formula/refs.js';
export { translateFormula, formulasEquivalent } from './formula/translate.js';
