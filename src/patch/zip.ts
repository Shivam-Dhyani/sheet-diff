import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

/** The parts of an OOXML package, keyed by path. */
export type Parts = Record<string, Uint8Array>;

export function unzip(bytes: Uint8Array): Parts {
  return unzipSync(bytes);
}

/**
 * Re-zip the parts. Untouched entries keep their exact bytes (TDD §10.1); only
 * the parts the writer replaced differ. Deflate level 6 is a reasonable default
 * — Excel does not care about the compression level.
 */
export function zip(parts: Parts): Uint8Array {
  const level = 6 as const;
  const opts: Record<string, { level: 0 | 6 }> = {};
  for (const name of Object.keys(parts)) opts[name] = { level };
  return zipSync(parts, opts);
}

export function readText(parts: Parts, name: string): string {
  const b = parts[name];
  return b ? strFromU8(b) : '';
}

export function writeText(parts: Parts, name: string, text: string): void {
  parts[name] = strToU8(text);
}

/** Escape text for an XML text node / attribute value. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
