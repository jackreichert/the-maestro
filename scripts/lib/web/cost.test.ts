// Run: node --test scripts/lib/web/cost.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCostWidget } from './cost.ts';
import type { TableRow } from '../../token-metrics.ts';
import type { RegistryRow } from '../cost-registry.ts';

const TARGETS = { opus_share_max: 40, haiku_share_min: 15, read_per_turn_max: 200000, wakes_per_prompt_max: 0.5, turns_since_compact_max: 150, opus_priced_share_max: 50 };

/** A 24-cell row with the cells the widget reads: 3 prompts, 4 wakes, 9 read per turn, 15 read mix, 17 max turns since compact. */
function row(date: string, o: { readPerTurn?: string; wakes?: string; mix?: string } = {}): TableRow {
  const cells = Array.from({ length: 24 }, () => '-');
  cells[0] = date; cells[3] = '10'; cells[4] = o.wakes ?? '3 (1/2)'; cells[9] = o.readPerTurn ?? '100k'; cells[15] = o.mix ?? 'opus 300 · sonnet 500 · haiku 200'; cells[17] = '90';
  return cells;
}
const days = (n: number, from = '2026-10-01'): string[] => Array.from({ length: n }, (_, i) => { const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
const table = (rows: TableRow[]): Map<string, TableRow> => new Map(rows.map((r) => [r[0] as string, r]));
const build = (rows: TableRow[], today: string, registry: RegistryRow[] = []) => buildCostWidget({ rows: table(rows), registry, today, targets: TARGETS, prices: null });
const metric = (d: ReturnType<typeof build>, name: string) => d.metrics.find((m) => m.name === name)!;

test('an empty history is an empty state with a reason, not a page of zeros', () => {
  const d = build([], '2026-10-13');
  assert.equal(d.state, 'empty');
  assert.match(d.reason ?? '', /no day to show/);
  assert.deepEqual([d.metrics, d.regressions, d.mix, d.date], [[], [], null, null]);
});

test('a metric more than 20 percent above its 7-day median is flagged, and one inside the band is not', () => {
  const rows = [...days(8).map((d) => row(d)), row('2026-10-09', { readPerTurn: '150k', wakes: '3 (1/2)' })];
  const d = build(rows, '2026-10-09');
  assert.equal(d.date, '2026-10-09');
  assert.equal(metric(d, 'Read/turn').regression, true);
  assert.ok(Math.abs((metric(d, 'Read/turn').vs7 ?? 0) - 0.5) < 1e-9);
  assert.equal(metric(d, 'Wakes/prompt').regression, false);
  assert.ok(d.regressions.includes('Read/turn'));
});

test('the series has one entry per calendar day ending at the shown day, with null where a day has no row', () => {
  const rows = [row('2026-10-01'), row('2026-10-03'), row('2026-10-05')];
  const d = build(rows, '2026-10-05');
  const s = metric(d, 'Read/turn').series;
  assert.equal(s.length, 14);
  assert.equal(d.days.at(-1), '2026-10-05');
  assert.deepEqual([s.at(-1), s.at(-2), s.at(-3)], [100000, null, 100000]);
});

test('the mix reports Opus and Haiku as fractions of the orchestrator read, against the targets', () => {
  const d = build([row('2026-10-05', { mix: 'opus 570 · sonnet 340 · haiku 90' })], '2026-10-05');
  assert.deepEqual(d.mix, { opus: 0.57, sonnet: 0.34, haiku: 0.09, opusMax: 0.4, haikuMin: 0.15 });
  assert.equal(metric(d, 'Opus share (read)').status, 'MISS');
  assert.equal(metric(d, 'Haiku share (read)').status, 'MISS');
  const ok = build([row('2026-10-05')], '2026-10-05');
  assert.equal(metric(ok, 'Opus share (read)').status, 'PASS');
  assert.equal(metric(ok, 'Haiku share (read)').status, 'PASS');
});

test('a day with no model mix has null shares rather than a made-up split', () => {
  const d = build([row('2026-10-05', { mix: '-' })], '2026-10-05');
  assert.deepEqual([d.mix?.opus, d.mix?.haiku], [null, null]);
});

test('history older than yesterday is marked stale, and a future row is not shown as today', () => {
  assert.equal(build([row('2026-10-01')], '2026-10-13').stale, true);
  assert.equal(build([row('2026-10-12')], '2026-10-13').stale, false);
  assert.equal(build([row('2026-10-20')], '2026-10-13').state, 'empty');
});

test('registry rows split into running, the last five closed ones, and the experiment proposed for today', () => {
  const r = (id: string, status: string): RegistryRow => ({ id, practice: `p-${id}`, hypothesis: '', metric: 'm', threshold: 't', start: '2026-10-01', status, result: 'res' });
  const registry = [r('A', 'adopted'), r('B', 'running'), r('C', 'reverted'), r('D', 'adopted'), r('E', 'adopted'), r('F', 'adopted'), r('G', 'adopted'), r('cx-2026-10-13', 'proposed')];
  const d = build([row('2026-10-12')], '2026-10-13', registry);
  assert.deepEqual(d.running.map((e) => e.id), ['B']);
  assert.deepEqual(d.recent.map((e) => e.id), ['G', 'F', 'E', 'D', 'C']);
  assert.equal(d.today?.id, 'cx-2026-10-13');
  assert.equal(build([row('2026-10-12')], '2026-10-14', registry).today?.id, 'cx-2026-10-13', 'the runner records yesterday\'s numbers under yesterday\'s id, still the current proposal');
  assert.equal(build([row('2026-10-12')], '2026-10-15', registry).today, null, 'older than yesterday is not current');
});

test('buildCost reads the table and registry under the notes vault, and says why when there is no vault or no table', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { buildCost } = await import('./cost.ts');
  const root = mkdtempSync(join(tmpdir(), 'cost-vault-'));
  const research = join(root, 'Projects', 'proj', 'Research');
  mkdirSync(research, { recursive: true });
  const cfg = { vault: root, project: 'proj', statusDir: root, page: { tz: 'UTC' }, vaultRoot: root } as unknown as Parameters<typeof buildCost>[0];
  assert.match(buildCost({ ...cfg, vaultRoot: undefined }).reason ?? '', /No notes vault/);
  assert.equal(buildCost(cfg, new Date('2026-10-13T12:00:00Z')).state, 'empty', 'no table yet');
  writeFileSync(join(research, 'token-metrics.md'), `| Date | x |\n|---|---|\n| 2026-10-12 | ${row('2026-10-12').slice(1).join(' | ')} |\n`);
  writeFileSync(join(research, 'token-usage-strategies.md'), '| Id | Practice | Hypothesis | Metric | Success threshold | Start | Status | Result |\n|---|---|---|---|---|---|---|---|\n| B | Haiku sweeps | h | m | t | 2026-10-01 | running | - |\n');
  const d = buildCost(cfg, new Date('2026-10-13T12:00:00Z'));
  assert.equal(d.date, '2026-10-12');
  assert.deepEqual(d.running.map((e) => e.id), ['B']);
});
