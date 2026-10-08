#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import process from 'node:process';
import { readWorkbook } from '../src/read/index.js';
import { analyzePair, compareWorkbooks } from '../src/compare/index.js';
import { planMerge } from '../src/merge/plan.js';
import { resolveMerge } from '../src/merge/resolve.js';
import { buildMergeLog } from '../src/merge/log.js';
import { applyMergePatch } from '../src/patch/index.js';
import type { Resolutions, ConflictResolution } from '../src/merge/types.js';
import { writeFile } from 'node:fs/promises';
import { isSheetDiffError } from '../src/errors.js';
import type { CompareOptions } from '../src/options.js';
import type { CompareResult } from '../src/types.js';

interface Args {
  positionals: string[];
  json: boolean;
  key?: string;
  password?: string;
  out?: string;
  resolve: string[];
  extendTotals: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { positionals: [], json: false, resolve: [], extendTotals: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--extend-totals') args.extendTotals = true;
    else if (a === '--key') {
      const v = argv[++i];
      if (v !== undefined) args.key = v;
    } else if (a === '--password') {
      const v = argv[++i];
      if (v !== undefined) args.password = v;
    } else if (a === '--out') {
      const v = argv[++i];
      if (v !== undefined) args.out = v;
    } else if (a === '--resolve') {
      const v = argv[++i];
      if (v !== undefined) args.resolve.push(v);
    } else args.positionals.push(a);
  }
  return args;
}

const HELP = `sheet-diff — compare two spreadsheets (identity-aware, formula-aware)

Usage:
  sheet-diff <old> <new> [--json] [--key "Invoice No"] [--password PW]
  sheet-diff merge <base> <copy1> <copy2> [--json]
            [--resolve KEY=Copy1|Copy2|delete]... [--extend-totals] [--out merged.xlsx]

Options:
  --json             Emit machine-readable JSON instead of a human summary
  --key NAME         Force a key column (applied to every matched sheet)
  --password PW      Password for an encrypted file
  --resolve K=CHOICE Resolve a conflict on key K (copy label / "delete")
  --extend-totals    Extend total formulas to include new rows
  --out FILE         Write the merged .xlsx (requires all conflicts resolved)
  -h, --help         Show this help
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }

  if (args.positionals[0] === 'merge') {
    await runMerge(args);
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

async function runMerge(args: Args): Promise<void> {
  // sheet-diff merge <base> <copy1> <copy2> [--json]
  const [, basePath, aPath, bPath] = args.positionals;
  if (!basePath || !aPath || !bPath) {
    process.stderr.write('Expected three files: sheet-diff merge <base> <copy1> <copy2>\n');
    process.exitCode = 2;
    return;
  }
  const rd = async (p: string) =>
    readWorkbook(new Uint8Array(await readFile(p)), {
      fileName: basename(p),
      keepSourceBytes: true,
      ...(args.password ? { password: args.password } : {}),
    });
  const base = await rd(basePath);
  const a = await rd(aPath);
  const b = await rd(bPath);
  const labels: [string, string] = ['Copy 1', 'Copy 2'];
  const plan = planMerge(base, a, b, { labels });

  // --out: resolve conflicts from --resolve flags and write the patched file.
  if (args.out) {
    const conflicts: Record<string, ConflictResolution> = {};
    const byKey = new Map<string, string>();
    for (const r of args.resolve) {
      const [k, v] = r.split('=');
      if (k && v) byKey.set(k, v);
    }
    for (const c of plan.conflicts) {
      if (!c.key) continue;
      const choice = byKey.get(c.key);
      if (choice === undefined) continue;
      conflicts[c.id] =
        choice === 'delete' ? 'delete' : choice === labels[1] || choice === 'Copy2' ? 'B' : 'A';
    }
    const resolutions: Resolutions = { conflicts };
    const changeSet = resolveMerge(base, plan, resolutions, { extendTotals: args.extendTotals });
    const log = buildMergeLog(plan, resolutions, labels);
    const patch = await applyMergePatch(base, changeSet, {
      sourceLabels: labels,
      now: new Date(),
      log,
      ...(args.password ? { password: args.password } : {}),
    });
    await writeFile(args.out, patch.bytes);
    process.stdout.write(
      `Wrote ${args.out} — ${patch.applied.length} change(s) applied, ${patch.blocked.length} blocked.\n`,
    );
    return;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return;
  }

  const w = process.stdout.write.bind(process.stdout);
  w(`\nSheetLens / sheet-diff — assisted merge\n`);
  w(`Key column: ${plan.keyColumns.join(' / ') || '(none)'}\n`);
  w(`\n${plan.proposals.length} auto-proposal(s), ${plan.conflicts.length} conflict(s) to resolve.\n`);
  if (plan.conflicts.length > 0) {
    w('\nConflicts:\n');
    for (const c of plan.conflicts) {
      w(`  • [${c.type}] ${c.key ?? ''}${c.column ? ` · ${c.column}` : ''}\n`);
    }
  }
  w('\nAuto-proposals (pre-ticked):\n');
  for (const p of plan.proposals) {
    if (p.kind === 'cell') w(`  • ${p.key} · ${p.column}: → ${JSON.stringify(p.value)} (${p.source})\n`);
    else if (p.kind === 'row_add') w(`  • add ${p.key} after ${p.afterKey} (${p.source})\n`);
    else w(`  • delete ${p.key} (${p.source})\n`);
  }
  w('\n(Resolve conflicts, then download the patched copy — patch writer lands in the next release.)\n');
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
