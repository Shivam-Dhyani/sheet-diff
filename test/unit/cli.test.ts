import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const dir = resolve(root, 'docs/fixtures/compare');
const has = existsSync(resolve(dir, 'expected.json'));

/** Run the real CLI source (via tsx) and return stdout. */
function cli(...args: string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx', 'bin/cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

(has ? describe : describe.skip)('CLI (compare fixture)', () => {
  const oldFile = resolve(dir, 'Sales_Register_Sep2026_v1.xlsx');
  const newFile = resolve(dir, 'Sales_Register_Sep2026_FINAL.xlsx');

  it('prints the same headline and contrast figures as the report model (89, not 92)', () => {
    const out = cli(oldFile, newFile);
    expect(out).toContain('8 real change(s) found — 4 need your attention.');
    // The Summary sheet's 3 same-address differences must not be added in.
    expect(out).toContain('would flag 89 cells');
    expect(out).not.toContain('would flag 92 cells');
  }, 30_000);
});
