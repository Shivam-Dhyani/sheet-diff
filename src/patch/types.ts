import type { MergeLogRow } from '../merge/types.js';

export interface BlockedOp {
  sheet: string;
  key: string;
  op: 'insert' | 'delete';
  reason: string;
}

export interface FidelityReport {
  charts: boolean;
  pivotTables: boolean;
  macros: boolean;
  comments: boolean;
  conditionalFormats: boolean;
  dataValidation: boolean;
}

export interface PatchOutput {
  bytes: Uint8Array;
  applied: MergeLogRow[];
  blocked: BlockedOp[];
  fidelity: FidelityReport;
}

export interface PatchOptions {
  sourceLabels: [string, string];
  password?: string;
  now?: Date;
  /** Optional pre-built merge log (else derived from the change set). */
  log?: MergeLogRow[];
}
