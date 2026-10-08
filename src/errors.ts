/**
 * Engine error catalogue (TDD §18). Every recoverable failure is surfaced as a
 * {@link SheetDiffError} carrying a stable `code` so the UI/CLI can map it to a
 * user message and an offered action. Errors never contain cell values or file
 * names beyond what the caller already has.
 */

export type SheetDiffErrorCode =
  | 'UNSUPPORTED_TYPE'
  | 'CORRUPT_FILE'
  | 'PASSWORD_REQUIRED'
  | 'PASSWORD_WRONG'
  | 'ENCRYPTION_UNSUPPORTED'
  | 'FILE_TOO_LARGE'
  | 'OUT_OF_MEMORY_OR_CRASH'
  | 'NO_COMMON_SHEETS'
  | 'MERGE_NO_KEY'
  | 'MERGE_XLS'
  | 'MERGE_UNRESOLVED'
  | 'PATCH_SELFCHECK_FAILED'
  | 'REPORT_FAILED'
  | 'ABORTED';

export class SheetDiffError extends Error {
  readonly code: SheetDiffErrorCode;
  readonly data: Record<string, unknown>;

  constructor(code: SheetDiffErrorCode, message?: string, data: Record<string, unknown> = {}) {
    super(message ?? code);
    this.name = 'SheetDiffError';
    this.code = code;
    this.data = data;
    Object.setPrototypeOf(this, SheetDiffError.prototype);
  }
}

export function isSheetDiffError(e: unknown): e is SheetDiffError {
  return e instanceof SheetDiffError;
}
