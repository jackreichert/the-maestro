#!/usr/bin/env node
/**
 * COST EXPERIMENT: the daily cost experiment's two mechanical steps. A cheap runner follows playbooks/cost-experiment.md.
 *
 *   node scripts/cost-experiment.ts propose [--date YYYY-MM-DD] [--vault <notes vault>] [--project <name>]
 *   node scripts/cost-experiment.ts write --date YYYY-MM-DD --practice "<text>" --hypothesis "<text>" --metric "<name>" --threshold "<text>" [--habit <key>] [--vault ..] [--project ..] [--dry-run]
 *
 * `propose` reads yesterday's row of the token table (`token-metrics.ts --write` keeps it), compares it with the 7 days before, and prints
 * the input a proposal is written from, as JSON: the metric to work on (the largest regression; when nothing regressed, the model-mix
 * metric furthest from its target), the numbers, the experiments already running on that metric and the approved habits. It writes nothing.
 * `write` adds one row, id `cx-<date>`, to the experiment registry note; a second run for the same date changes nothing. A row for an
 * approved habit (--habit) starts as `running`; any other starts as `proposed` and needs a decision.
 * Exit 0 on success (a row already there included), 2 on a usage error or an unreadable table or note.
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTAINER_PROJECT, COST_TARGETS, MODEL_PRICES, VAULT_ROOT, WATCH_TZ } from './local-config.ts';
import { compare, readTable } from './token-metrics.ts';
import { APPROVED_HABITS, selectTarget, startStatus } from './lib/cost-experiment.ts';
import { addRegistryRow, experimentId, isDay, parseRegistry } from './lib/cost-registry.ts';
import { shiftDay } from './lib/web/cost.ts';
import { localDate } from './lib/status-page/priorities.ts';
import { printJson } from './lib/json-out.ts';

const NOTE = 'token-usage-strategies.md';
const MAX_CELL = 400;
const REQUIRED = ['date', 'practice', 'hypothesis', 'metric', 'threshold'];

class Usage extends Error {}

function main(argv: string[]): void {
  const [sub, ...rest] = argv;
  const arg = (n: string, d = ''): string => { const i = rest.indexOf(`--${n}`); return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] as string : d; };
  const research = join(arg('vault', VAULT_ROOT), 'Projects', arg('project', CONTAINER_PROJECT), 'Research');
  try {
    if (VAULT_ROOT === '' && !arg('vault')) throw new Usage('no notes vault: pass --vault or set vault_root');
    if (sub === 'propose') propose(research, arg('date') || shiftDay(localDate(new Date(), WATCH_TZ), -1));
    else if (sub === 'write') write(join(research, NOTE), Object.fromEntries([...REQUIRED, 'habit'].map((k) => [k, arg(k)])), rest.includes('--dry-run'));
    else throw new Usage('usage: cost-experiment.ts propose [--date D] | write --date D --practice .. --hypothesis .. --metric .. --threshold .. [--habit key]');
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}

function propose(research: string, date: string): void {
  if (!isDay(date)) throw new Usage(`--date must be YYYY-MM-DD, got "${date}"`);
  const rows = readTable(join(research, 'token-metrics.md'));
  const note = join(research, NOTE);
  const registry = existsSync(note) ? parseRegistry(readFileSync(note, 'utf8')) : [];
  const has = rows.has(date);
  const pick = selectTarget(has ? compare(date, rows, '0000-00-00', { targets: COST_TARGETS, prices: MODEL_PRICES }) : [], MODEL_PRICES);
  printJson({
    date, id: experimentId(date), hasRow: has,
    ...(has ? {} : { missing: `the token table has no row for ${date}; run: node scripts/token-metrics.ts --date ${date} --write` }),
    pick, runningOnMetric: registry.filter((r) => r.status === 'running' && pick.metric && r.metric.includes(pick.metric)).map((r) => r.id),
    alreadyProposed: registry.some((r) => r.id === experimentId(date)),
    habits: APPROVED_HABITS,
  });
}

function write(note: string, f: Record<string, string>, dryRun: boolean): void {
  const missing = REQUIRED.filter((k) => !f[k]);
  if (missing.length) throw new Usage(`write needs ${missing.map((k) => `--${k}`).join(', ')}`);
  if (!isDay(f.date as string)) throw new Usage(`--date must be YYYY-MM-DD, got "${f.date}"`);
  if (f.habit && !Object.hasOwn(APPROVED_HABITS, f.habit)) throw new Usage(`unknown --habit "${f.habit}"; approved: ${Object.keys(APPROVED_HABITS).join(', ')}`);
  const long = REQUIRED.find((k) => (f[k] as string).length > MAX_CELL);
  if (long) throw new Usage(`--${long} is over ${MAX_CELL} characters; the registry holds one short line per cell`);
  if (!existsSync(note)) throw new Usage(`the registry note does not exist: ${note}`);
  const id = experimentId(f.date as string);
  const status = startStatus(f.habit || undefined);
  const text = readFileSync(note, 'utf8');
  const next = addRegistryRow(text, { id, practice: f.practice as string, hypothesis: f.hypothesis as string, metric: f.metric as string, threshold: f.threshold as string, start: f.date as string, status, result: '-' });
  if (next === null) throw new Usage('the registry note has no experiment table (a header row starting "| Id | Practice |")');
  if (next === text) { console.log(`${id}  already recorded; nothing written`); return; }
  if (dryRun) { console.log(`[dry-run] ${id}  would be added as ${status}`); return; }
  writeFileSync(`${note}.tmp`, next);
  renameSync(`${note}.tmp`, note);
  console.log(`${id}  added as ${status}${status === 'proposed' ? '; it needs a decision, so raise a Podium ask with a recommendation' : ''}`);
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) main(process.argv.slice(2));
