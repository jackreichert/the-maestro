// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/projects.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../journal/store.ts';
import { writePriorities } from '../status-page/priorities.ts';
import { assertNoCanary, buildFixture, snapshot } from '../vault/fixture.ts';
import { buildProjects, nowLine, stateWord, weekly } from './projects.ts';
import type { ThroughputDay } from './charts.ts';

const NOW = new Date('2026-10-07T15:00:00Z');
const DAY = '2026-10-07';

/** A fictional vault and ledger: Avonlea is configured and busy, Green Gables has one blocked row and no notes, Orchard has only a priority. */
function setup(): { cfg: Parameters<typeof buildProjects>[0]; roots: string[] } {
  const fx = buildFixture();
  fx.write('Projects/avonlea-api/CONTEXT.md', '---\ntitle: Avonlea API context\n---\n# Context\n\n## Now\n\n- **Cutover** rehearsal on the staging copy\n\n## Later\n');
  fx.write('Projects/avonlea-api/INDEX.md', '# Library\n');
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'projects-ledger-'));
  const statusDir = join(ledgerRoot, 'Status');
  mkdirSync(statusDir, { recursive: true });
  writeFileSync(join(statusDir, 'stream-homes.json'), JSON.stringify({ version: 1, streams: { Avonlea: {
    projects: ['avonlea-api', 'credentials.json'],
    pins: [{ label: 'Dashboard', url: 'https://dash.example.com/d/1' }, { label: 'Secret', note: 'Projects/avonlea-api/.env.md' }, { label: 'Runbook', note: 'Projects/avonlea-api/Runbooks/cutover.md' }],
  } } }));
  writePriorities(statusDir, DAY, [{ text: 'Plant the orchard', stream: 'Orchard' }, { text: 'Rehearse the cutover', stream: 'Avonlea' }]);
  const store = openStore({ vault: ledgerRoot, project: 'p', dryRun: false });
  const row = (o: Record<string, unknown>): void => { store.append({ ts: `${DAY}T12:00:00Z`, date: DAY, ...o }); };
  row({ id: 'ask1', kind: 'question', text: 'Approve the backfill window?', stream: 'Avonlea' });
  row({ id: 'wip1', kind: 'wip', text: 'Port the loader', stream: 'Avonlea', ts: '2026-10-03T12:00:00Z', date: '2026-10-03' });
  row({ id: 'wip2', kind: 'wip', text: 'Old cron', stream: 'Avonlea', ts: '2026-10-01T12:00:00Z', date: '2026-10-01' });
  row({ id: 'dn01', kind: 'done', text: 'Old cron', closes: 'wip2', ts: '2026-10-06T13:00:00Z', date: '2026-10-06' });
  row({ id: 'blk1', kind: 'blocked', text: 'Pilot sign-off', stream: 'Green Gables' });
  const page = { streams: ['Avonlea', 'Green Gables', 'Orchard'], repoStreams: {}, vaultName: 'Vault', trackerUrlBase: 'https://tracker.test/browse/', ticketNotePath: '', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'UTC' };
  return { cfg: { vault: ledgerRoot, project: 'p', statusDir, page, vaultRoot: fx.root }, roots: [fx.root, ledgerRoot] };
}

test('the projects payload: a row per stream with counts, status, rank and state word, and touches nothing', () => {
  const { cfg, roots } = setup();
  const before = roots.map(snapshot);
  const data = buildProjects(cfg, NOW);
  const body = JSON.stringify(data);
  assert.deepEqual(roots.map(snapshot), before, 'vault, ledger and status dir are byte-identical');
  const by = Object.fromEntries(data.rows.map((r) => [r.stream, r]));
  assert.deepEqual(Object.keys(by).sort(), ['Avonlea', 'Green Gables', 'Orchard']);
  const a = by.Avonlea;
  assert.deepEqual(a.projects, ['avonlea-api'], 'a project named like a secret file is dropped by the config check');
  assert.deepEqual(a.status, { text: 'Cutover rehearsal on the staging copy', from: 'context' });
  assert.deepEqual([a.rank, a.asks, a.inflight, a.blocked, a.prs, a.oldestOpenDays, a.lastShipped, a.shippedWeek, a.state], [2, 1, 1, 0, 0, 4, '2026-10-06', 1, 'waiting on you']);
  const gg = by['Green Gables'];
  assert.deepEqual([gg.projects, gg.status, gg.rank, gg.state], [[], null, null, 'blocked'], 'no CONTEXT for the guessed folder: no project is claimed');
  const o = by.Orchard;
  assert.deepEqual([o.asks, o.inflight, o.blocked, o.oldestOpenDays, o.lastShipped, o.shippedWeek, o.state], [0, 0, 0, null, null, 0, 'quiet'], 'a stream with nothing open still gets its row');
  assert.deepEqual(o.status, { text: 'Plant the orchard', from: 'priority' });
  assert.equal(o.rank, 1);
  assert.deepEqual(data.links.map((l) => [l.kind, l.label]), [['pin', 'Dashboard'], ['pin', 'Runbook'], ['context', 'avonlea-api context'], ['library', 'avonlea-api library']]);
  assert.ok(data.links.every((l) => /^(https:|obsidian:)/.test(l.url)));
  assert.equal(data.weeks.length, 8);
  assert.equal(data.weeks.at(-1)?.byStream.Avonlea, 1);
  assertNoCanary(body);
  assert.ok(!/\.env|credentials/.test(body), 'no secret-shaped name is listed');
  assert.ok(roots.every((r) => !body.includes(r)), 'no absolute path in the payload');
});

test('without a vault root the rows still come, with no notes and no note links', () => {
  const { cfg } = setup();
  const data = buildProjects({ ...cfg, vaultRoot: undefined }, NOW);
  assert.equal(data.rows.find((r) => r.stream === 'Avonlea')?.status?.from, 'priority');
  assert.deepEqual(data.links.map((l) => l.kind), ['pin', 'pin']);
});

test('stateWord: an ask beats blocked beats moving; nothing open and nothing shipped is quiet', () => {
  assert.equal(stateWord({ asks: 1, blocked: 1, inflight: 1 }, 3), 'waiting on you');
  assert.equal(stateWord({ asks: 0, blocked: 2, inflight: 1 }, 0), 'blocked');
  assert.equal(stateWord({ asks: 0, blocked: 0, inflight: 0 }, 1), 'moving');
  assert.equal(stateWord({ asks: 0, blocked: 0, inflight: 0 }, 0), 'quiet');
});

test('nowLine: the first text under ## Now, never a line from the next section', () => {
  assert.equal(nowLine('# C\n## Now\n\n1. `Ship` it\n'), 'Ship it');
  assert.equal(nowLine('## Now\n\n## Next\n- later\n'), '');
  assert.equal(nowLine('# no now section\n- x\n'), '');
  assert.equal(nowLine(`## Now\n${'x'.repeat(400)}\n`).length, 160);
});

test('weekly: seven-day periods counted back from today, the oldest one partial', () => {
  const days: ThroughputDay[] = Array.from({ length: 9 }, (_, i) => ({ date: `2026-10-0${i + 1}`, total: 1, byStream: { a: 1 }, ids: [] }));
  assert.deepEqual(weekly(days), [{ start: '2026-10-01', total: 2, byStream: { a: 2 } }, { start: '2026-10-03', total: 7, byStream: { a: 7 } }]);
  assert.deepEqual(weekly([]), []);
});
