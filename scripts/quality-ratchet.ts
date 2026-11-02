#!/usr/bin/env node
/**
 * QUALITY RATCHET: per-file size and complexity may not get worse than `quality-baseline.json`.
 *
 *   node scripts/quality-ratchet.ts [check] [--root <dir>]
 *   node scripts/quality-ratchet.ts update [--root <dir>] [--allow-loosen --reason "<why>"]
 *
 * check: exit 1 listing each regression (file, metric, baseline, now); new files must meet the
 * limits outright. Improvements print a notice to run `npm run ratchet:update`.
 * update: rewrites the baseline, tighten only (the first run, with no baseline file, adopts existing debt). `--allow-loosen` needs `--reason`, recorded in the file.
 * Exit 0 ok, 1 regression or refused update, 2 bad usage.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, update, formatRegression } from './lib/quality-ratchet/ratchet.ts';
import { scanRepo, readBaseline, baselineExists, writeBaseline } from './lib/quality-ratchet/scan.ts';

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function runCheck(root: string): number {
  const result = check(readBaseline(root), scanRepo(root));
  for (const i of result.improvements) {
    console.log(`better: ${i.file}  ${i.metric}  baseline ${i.baseline}  now ${i.now}`);
  }
  for (const f of result.stale) console.log(`gone: ${f} is in the baseline but no longer exists`);
  if (result.improvements.length + result.stale.length > 0) console.log('Lower the baseline: npm run ratchet:update');
  if (result.regressions.length === 0) { console.log('ratchet: ok'); return 0; }
  console.error('ratchet: regressions (file  metric  baseline  now)');
  for (const r of result.regressions) console.error(`  ${formatRegression(r)}`);
  console.error('Fix the code. Only if the loosening is deliberate: npm run ratchet:update -- --allow-loosen --reason "<why>"');
  return 1;
}

function runUpdate(root: string, argv: string[]): number {
  const loosen = argv.includes('--allow-loosen');
  const reason = arg(argv, '--reason')?.trim();
  if (loosen && !reason) { console.error('--allow-loosen needs --reason "<why>"'); return 2; }
  const date = new Date().toISOString().slice(0, 10);
  const { baseline, blocked } = update(readBaseline(root), scanRepo(root), loosen ? { reason: reason as string, date } : undefined, !baselineExists(root));
  if (blocked.length > 0) {
    console.error('ratchet:update refused, these got worse (file  metric  baseline  now)');
    for (const r of blocked) console.error(`  ${formatRegression(r)}`);
    return 1;
  }
  writeBaseline(root, baseline);
  console.log(`ratchet: baseline written, ${Object.keys(baseline.files).length} files with debt`);
  return 0;
}

function main(argv: string[]): number {
  const root = resolve(arg(argv, '--root') ?? '.');
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'check';
  if (cmd === 'check') return runCheck(root);
  if (cmd === 'update') return runUpdate(root, argv);
  console.error(`unknown command: ${cmd}`);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
