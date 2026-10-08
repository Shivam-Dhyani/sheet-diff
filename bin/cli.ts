#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import process from 'node:process';
import { readWorkbook } from '../src/read/index.js';
import { analyzePair, compareWorkbooks } from '../src/compare/index.js';
import { isSheetDiffError } from '../src/errors.js';
import type { CompareOptions } from '../src/options.js';
import type { CompareResult } from '../src/types.js';

interface Args {
  positionals: string[];
  json: boolean;
  key?: string;
  password?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { positionals: [], json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--key') {
      const v = argv[++i];
      if (v !== undefined) args.key = v;
    } else if (a === '--password') {
      const v = argv[++i];
      if (v !== undefined) args.password = v;
    } else args.positionals.push(a);
  }
  return args;
}

const HELP = `sheet-diff — compare two spreadsheets (identity-aware, formula-aware)

Usage:
  sheet-diff <old> <new> [--json] [--key "Invoice No"] [--password PW]
  sheet-diff merge <base> <a> <b> [--json]        (coming in a later release)

Options:
  --json         Emit machine-readable JSON instead of a human summary
  --key NAME     Force a key column (applied to every matched sheet)
  --password PW  Password for an encrypted file (applies to both inputs)
  -h, --help     Show this help
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }

  if (args.positionals[0] === 'merge') {
    process.stderr.write('Merge is not available yet in this release.\n');
    process.exitCode = 2;
    return;
  }

  if (args.positionals.length < 2) {
    process.stderr.write('Expected two files: sheet-diff <old> <new>\n');
    process.exitCode = 2;
    return;
  }

  const [oldPath, newPath] = args.positionals;
  const oldBytes = new Uint8Array(await readFile(oldPath!));
  const newBytes = new Uint8Array(await readFile(newPath!));

  const readOpts = args.password ? { password: args.password } : {};
  const oldWb = await readWorkbook(oldBytes, { fileName: basename(oldPath!), ...readOpts });
  const newWb = await readWorkbook(newBytes, { fileName: basename(newPath!), ...readOpts });

  const opts: Partial<CompareOptions> = {};
  if (args.key) {
    const analysis = analyzePair(oldWb, newWb);
    const keys: Record<string, string[]> = {};
    for (const p of analysis.pairs) {
      if (p.status === 'matched' || p.status === 'renamed') keys[p.id] = [args.key];
    }
    opts.keys = keys;
  }

  const result = compareWorkbooks(oldWb, newWb, opts);

  if (args.json) {
    process.stdout.write(JSON.stringify(toJson(result), null, 2) + '\n');
  } else {
    printHuman(result, basename(oldPath!), basename(newPath!));
  }
}

function toJson(result: CompareResult): unknown {
  return {
    counts: result.counts,
    positionalBaseline: result.positionalBaseline,
    durationMs: result.durationMs,
    findings: result.findings,
    pairs: result.pairs.map((p) => ({
      id: p.id,
      oldName: p.oldName,
      newName: p.newName,
      status: p.status,
      key: p.key,
      columns: p.columns,
      rowMap: Array.from(p.rowMap),
      rowStatus: Array.from(p.rowStatus),
      cellChanges: p.cellChanges,
    })),
  };
}

function printHuman(result: CompareResult, oldName: string, newName: string): void {
  const { counts } = result;
  const w = process.stdout.write.bind(process.stdout);
  const total = result.pairs.reduce((s, p) => s + p.cellChanges.length, 0);
  const positional = Object.values(result.positionalBaseline).reduce((s, n) => s + n, 0);

  w(`\nSheetLens / sheet-diff — ${newName} vs ${oldName}\n`);
  if (counts.realChanges === 0) {
    w('No differences — these files contain the same data.\n');
  } else {
    w(
      `${counts.realChanges} real change(s) found — ${counts.needsAttention} need your attention.\n`,
    );
    w(`(A basic cell-by-cell compare would flag ${positional} cells.)\n`);
  }
  w(
    `\nRows added: ${counts.rowsAdded} · Rows removed: ${counts.rowsRemoved} · ` +
      `Cells edited by hand: ${counts.cellsEditedByHand} · Formulas overwritten: ${counts.formulasOverwritten} · ` +
      `Recalculated: ${counts.recalculated}\n`,
  );

  const high = result.findings.filter((f) => f.severity === 'high');
  const medium = result.findings.filter((f) => f.severity === 'medium');
  const info = result.findings.filter((f) => f.severity === 'info');
  printSection(w, 'Needs attention (High)', high);
  printSection(w, 'To review (Medium)', medium);
  printSection(w, 'Info', info);
  w(`\n(${total} cell change(s) across ${result.pairs.length} sheet pair(s).)\n`);
}

function printSection(
  w: (s: string) => boolean,
  title: string,
  findings: CompareResult['findings'],
): void {
  if (findings.length === 0) return;
  w(`\n${title}:\n`);
  for (const f of findings.slice(0, 50)) {
    w(`  • [${f.rule}] ${f.message}\n`);
  }
  if (findings.length > 50) w(`  … and ${findings.length - 50} more\n`);
}

main().catch((e: unknown) => {
  if (isSheetDiffError(e)) {
    process.stderr.write(`Error (${e.code}): ${e.message}\n`);
  } else {
    process.stderr.write(`Unexpected error: ${String((e as Error)?.message ?? e)}\n`);
  }
  process.exitCode = 1;
});
