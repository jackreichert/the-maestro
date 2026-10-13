// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/cost-experiment.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRegistry } from './lib/cost-registry.ts';

const SCRIPT = fileURLToPath(new URL('./cost-experiment.ts', import.meta.url));
const REGISTRY = '| Id | Practice | Hypothesis | Metric | Success threshold | Start | Status | Result |\n|---|---|---|---|---|---|---|---|\n| B | Haiku sweeps | h | Haiku share (read) | at least 15% | 2026-10-01 | running | - |\n';

function vault(): { root: string; note: string } {
  const root = mkdtempSync(join(tmpdir(), 'cost-exp-'));
  const research = join(root, 'Projects', 'proj', 'Research');
  mkdirSync(research, { recursive: true });
  const note = join(research, 'token-usage-strategies.md');
  writeFileSync(note, REGISTRY);
  return { root, note };
}
/** A table row with the cells the metrics read; read per turn and the Haiku mix are the ones the tests move. */
function tableRow(date: string, readPerTurn: string, mix = 'opus 300 · sonnet 500 · haiku 200'): string {
  const cells = Array.from({ length: 24 }, () => '-');
  cells[0] = date; cells[3] = '10'; cells[4] = '3 (1/2)'; cells[9] = readPerTurn; cells[15] = mix; cells[17] = '90';
  return `| ${cells.join(' | ')} |`;
}
const run = (root: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args, '--vault', root, '--project', 'proj'], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', TZ: 'UTC' } });
const write = (root: string, date: string, extra: string[] = []) => run(root, 'write', '--date', date, '--practice', 'Cap reports', '--hypothesis', 'shorter', '--metric', 'Avg report', '--threshold', 'at most 1.5k', ...extra);

test('write adds one row per day: a second run changes nothing, and the table stays parseable', () => {
  const { root, note } = vault();
  const first = write(root, '2026-10-13');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /cx-2026-10-13 {2}added as proposed/);
  const once = readFileSync(note, 'utf8');
  const second = write(root, '2026-10-13');
  assert.equal(second.status, 0);
  assert.match(second.stdout, /already recorded/);
  assert.equal(readFileSync(note, 'utf8'), once);
  assert.deepEqual(parseRegistry(once).map((r) => r.id), ['B', 'cx-2026-10-13']);
  assert.equal(write(root, '2026-10-14', ['--habit', 'capped-reports']).status, 0);
  assert.equal(parseRegistry(readFileSync(note, 'utf8')).at(-1)?.status, 'running');
});

test('write refuses a missing field, an unknown habit, a bad date and a note with no table, and writes nothing', () => {
  const { root, note } = vault();
  assert.equal(run(root, 'write', '--date', '2026-10-13').status, 2);
  assert.match(write(root, '2026-10-13', ['--habit', 'invented']).stderr, /unknown --habit/);
  assert.match(write(root, '13-10-2026').stderr, /YYYY-MM-DD/);
  writeFileSync(note, '# no table here\n');
  assert.match(write(root, '2026-10-13').stderr, /no experiment table/);
  assert.equal(readFileSync(note, 'utf8'), '# no table here\n');
});

test('--dry-run reports what would be added and leaves the note alone', () => {
  const { root, note } = vault();
  const out = write(root, '2026-10-13', ['--dry-run']);
  assert.match(out.stdout, /would be added as proposed/);
  assert.equal(readFileSync(note, 'utf8'), REGISTRY);
});

test('propose names the largest regression from yesterday\'s row, and lists what already runs on it', () => {
  const { root } = vault();
  const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'].map((d) => tableRow(d, '100k'));
  writeFileSync(join(root, 'Projects', 'proj', 'Research', 'token-metrics.md'), ['| Date |', '|---|', ...days, tableRow('2026-10-12', '180k', 'opus 300 · sonnet 600 · haiku 100')].join('\n'));
  const r = run(root, 'propose', '--date', '2026-10-12');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.id, 'cx-2026-10-12');
  assert.equal(out.pick.basis, 'regression');
  assert.equal(out.pick.metric, 'Read/turn');
  assert.deepEqual(out.runningOnMetric, []);
  assert.equal(out.alreadyProposed, false);
});

test('propose with no row for the day says which command to run, and picks nothing', () => {
  const { root } = vault();
  const out = JSON.parse(run(root, 'propose', '--date', '2026-10-12').stdout);
  assert.equal(out.hasRow, false);
  assert.match(out.missing, /token-metrics\.ts --date 2026-10-12 --write/);
  assert.equal(out.pick.basis, 'none');
});

test('an unknown subcommand is a usage error', () => {
  assert.equal(run(vault().root, 'frobnicate').status, 2);
});
