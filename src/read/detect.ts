import { unzipSync } from 'fflate';
import type { WorkbookFormat } from '../ir/types.js';

export type Container = 'zip' | 'cfb' | 'text';

export interface FormatSniff {
  container: Container;
  /** Best-guess format. For an encrypted OOXML CFB this is 'xlsx'. */
  format: WorkbookFormat;
  /** True when the bytes are an encrypted container (needs a password). */
  encrypted: boolean;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/** Find a UTF-16LE encoded ASCII needle within the first `limit` bytes. */
function containsUtf16le(bytes: Uint8Array, needle: string, limit = 8192): boolean {
  const end = Math.min(bytes.length, limit);
  const first = needle.charCodeAt(0);
  for (let i = 0; i + needle.length * 2 <= end; i += 2) {
    if (bytes[i] !== first || bytes[i + 1] !== 0) continue;
    let ok = true;
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j * 2] !== needle.charCodeAt(j) || bytes[i + j * 2 + 1] !== 0) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

const MACRO_CONTENT_TYPE = 'macroEnabled.main+xml';

/** Inspect `[Content_Types].xml` of an OOXML zip to pick xlsx vs xlsm. */
function ooxmlFormat(bytes: Uint8Array): WorkbookFormat {
  try {
    const files = unzipSync(bytes, { filter: (f) => f.name === '[Content_Types].xml' });
    const ct = files['[Content_Types].xml'];
    if (ct) {
      const text = new TextDecoder('utf-8').decode(ct);
      if (text.includes(MACRO_CONTENT_TYPE)) return 'xlsm';
    }
  } catch {
    // fall through to xlsx default
  }
  return 'xlsx';
}

/**
 * Sniff the container and format from the raw bytes (TDD §7.1 step 1).
 * CSV/text is the fallback when no binary magic matches.
 */
export function sniffFormat(bytes: Uint8Array): FormatSniff {
  if (startsWith(bytes, ZIP_MAGIC)) {
    return { container: 'zip', format: ooxmlFormat(bytes), encrypted: false };
  }
  if (startsWith(bytes, CFB_MAGIC)) {
    // Encrypted OOXML is wrapped in a CFB with an `EncryptedPackage` stream.
    const encrypted = containsUtf16le(bytes, 'EncryptedPackage');
    // A non-encrypted CFB is a legacy .xls (BIFF). Encrypted OOXML decrypts to xlsx/xlsm.
    return { container: 'cfb', format: encrypted ? 'xlsx' : 'xls', encrypted };
  }
  return { container: 'text', format: 'csv', encrypted: false };
}

/** Quick async wrapper mirroring the public `isEncrypted` surface (TDD §6.3). */
export function detectEncrypted(bytes: Uint8Array): boolean {
  return sniffFormat(bytes).encrypted;
}
