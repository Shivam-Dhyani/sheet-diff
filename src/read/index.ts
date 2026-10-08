import { unzipSync } from 'fflate';
import type { WorkbookIR } from '../ir/types.js';
import { createSheet, SheetBuilder } from '../ir/sheet.js';
import { createStringPool } from '../ir/string-pool.js';
import { emptyFeatureInventory } from '../ir/types.js';
import type { ReadOptions } from '../options.js';
import { SheetDiffError } from '../errors.js';
import { sniffFormat } from './detect.js';
import { parseCsv, parseCsvNumber } from './csv.js';
import { readWithSheetJs } from './sheetjs-adapter.js';
import { readFeatures } from './features.js';

const MAX_UNCOMPRESSED = 1.5 * 1024 * 1024 * 1024; // 1.5 GB
const MAX_PARTS = 10000;

/** Public `isEncrypted` (TDD §6.3). */
export async function isEncrypted(bytes: Uint8Array): Promise<boolean> {
  return sniffFormat(bytes).encrypted;
}

/**
 * Read raw bytes into the compact IR (TDD §6.3, §7.1). Throws
 * {@link SheetDiffError} with a catalogue code (§18) on recoverable failures.
 */
export async function readWorkbook(bytes: Uint8Array, opts: ReadOptions): Promise<WorkbookIR> {
  if (opts.signal?.aborted) throw new SheetDiffError('ABORTED', 'Reading was cancelled.');

  let data = bytes;
  let sniff = sniffFormat(data);

  // Encrypted container → decrypt (requires a password).
  if (sniff.encrypted) {
    if (!opts.password) {
      throw new SheetDiffError('PASSWORD_REQUIRED', 'This file is password-protected.');
    }
    opts.onProgress?.({ phase: 'decrypt', message: 'Opening the protected file…' });
    const { decrypt } = await import('./decrypt.js');
    data = await decrypt(data, opts.password);
    sniff = sniffFormat(data);
  }

  const valuesOnly = opts.valuesOnly ?? false;

  if (sniff.container === 'text') {
    return readCsv(data, opts);
  }

  // Zip-bomb guards for OOXML (TDD §7.1 step 7).
  if (sniff.container === 'zip') {
    guardZip(data);
  }

  const wb = readWithSheetJs(data, {
    fileName: opts.fileName,
    format: sniff.format,
    valuesOnly,
    compareNumberFormats: false,
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  // Feature inventory (xlsx/xlsm only).
  if (sniff.container === 'zip' && (sniff.format === 'xlsx' || sniff.format === 'xlsm')) {
    opts.onProgress?.({ phase: 'features', message: 'Scanning workbook features…' });
    try {
      wb.features = readFeatures(data);
    } catch {
      wb.features = emptyFeatureInventory();
    }
  }

  if (opts.keepSourceBytes) wb.sourceBytes = data;
  return wb;
}

function guardZip(bytes: Uint8Array): void {
  let total = 0;
  let parts = 0;
  try {
    unzipSync(bytes, {
      filter: (f) => {
        parts++;
        total += f.originalSize || 0;
        return false; // never inflate during the guard pass
      },
    });
  } catch {
    throw new SheetDiffError('CORRUPT_FILE', 'This file could not be read.');
  }
  if (parts > MAX_PARTS || total > MAX_UNCOMPRESSED) {
    throw new SheetDiffError('FILE_TOO_LARGE', 'This file is too large to compare in a browser.', {
      parts,
      uncompressedBytes: total,
    });
  }
}

/** Build a single-sheet IR from CSV bytes. */
function readCsv(bytes: Uint8Array, opts: ReadOptions): WorkbookIR {
  const csvOpts: { delimiter?: string; encoding?: 'utf-8' | 'windows-1252' } = {};
  if (opts.csv?.delimiter !== undefined) csvOpts.delimiter = opts.csv.delimiter;
  if (opts.csv?.encoding !== undefined) csvOpts.encoding = opts.csv.encoding;
  const { rows } = parseCsv(bytes, csvOpts);

  const nRows = rows.length;
  const nCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const pool = createStringPool();
  const sheet = createSheet('Sheet1', nRows, nCols);
  const b = new SheetBuilder(sheet, pool);

  for (let r = 0; r < nRows; r++) {
    const row = rows[r]!;
    for (let c = 0; c < row.length; c++) {
      const raw = row[c]!;
      if (raw === '') continue;
      const n = parseCsvNumber(raw);
      if (n !== null) b.setNumber(r, c, n);
      else b.setString(r, c, raw);
    }
  }

  return {
    fileName: opts.fileName,
    format: 'csv',
    date1904: false,
    pool,
    sheets: [sheet],
    meta: {},
    features: emptyFeatureInventory(),
    ...(opts.keepSourceBytes ? { sourceBytes: bytes } : {}),
  };
}
