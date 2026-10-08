import type { SheetIR, WorkbookIR } from '../ir/types.js';
import type { CompareOptions, CheckOptions } from '../options.js';
import type { SheetPairResult } from '../types.js';
import type { TableModel } from '../table/index.js';
import type { TranslateContext } from '../formula/translate.js';

/** Per-pair data the checks operate on. */
export interface CheckPair {
  id: string;
  status: SheetPairResult['status'];
  result: SheetPairResult;
  oldSheet?: SheetIR;
  newSheet?: SheetIR;
  oldTable?: TableModel;
  newTable?: TableModel;
  oldKeyCols?: number[];
  newKeyCols?: number[];
  /** matched column pairs with headers. */
  columns?: { oldCol: number; newCol: number; header: string }[];
  translateCtx?: TranslateContext;
  /** new-side absolute rows that were added. */
  added?: number[];
  /** old-side absolute rows that were removed. */
  removed?: number[];
  /** new-side absolute rows detected as moved (order mode). */
  moved?: number[];
}

export interface CheckContext {
  oldWb: WorkbookIR;
  newWb: WorkbookIR;
  opts: CompareOptions;
  checkOpts: CheckOptions;
  pairs: CheckPair[];
}
