export { planMerge, type MergeOptions } from './plan.js';
export { resolveMerge, isTypedCell, type ResolveOptions } from './resolve.js';
export { previewImpact, buildMergedModel, computeExtendRanges } from './impact.js';
export { buildMergeLog } from './log.js';
export { mergeDiff } from './diff.js';
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
  AddAddResolution,
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
} from './types.js';
