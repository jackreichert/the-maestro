// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/api.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../journal/store.ts';
import type { RawPr } from '../status-page/generate.ts';
import { writePrCache } from '../status-page/prcache.ts';
import { writePriorities } from '../status-page/priorities.ts';
import { sanitizeCharts, sanitizeState } from '../../web/client/src/contract.ts';
import { buildCharts, buildState, buildStream } from './api.ts';
import type { WebConfig } from './api.ts';

const NOW = new Date('2026-10-06T15:00:00Z');
const DAY = '2026-10-06';

const raw = (n: number, o: Partial<RawPr> & { ci?: string } = {}): RawPr => ({
  number: n, title: `feat: widgets FAKE-${n}`, url: `https://example.test/acme/widgets/pull/${n}`, isDraft: false, baseRefName: 'develop', headRefName: `feat/FAKE-${n}-x`,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, repository: { nameWithOwner: 'acme/widgets' },
  reviewThreads: { nodes: [{ isResolved: false }] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: o.ci ?? 'SUCCESS' } } }] }, ...o,
});

/** A scratch ledger root and status directory, seeded with fictional rows. */
function fixture(): WebConfig {
  const vault = mkdtempSync(join(tmpdir(), 'web-state-'));
  const statusDir = join(vault, 'Status');
  const store = openStore({ vault, project: 'p', dryRun: false });
  mkdirSync(join(vault, 'Projects', 'p'), { recursive: true });
  writeFileSync(join(vault, 'Projects', 'p', 'streams.json'), JSON.stringify({ streams: { widgets: { aliases: [], status: 'active' }, ops: { aliases: [], status: 'active' } } }));
  const row = (o: Record<string, unknown>) => store.append({ ts: `${DAY}T12:00:00Z`, date: DAY, ...o });
  row({ id: 'ask1', kind: 'question', text: 'Merge the exporter PR #12? CI is green, see FAKE-12.', stream: 'widgets' });
  row({ id: 'wip1', kind: 'wip', text: 'Export schema validation', stream: 'widgets', model: 'claude-sonnet-5-5' });
  row({ id: 'que1', kind: 'wip', text: 'Write docs', stream: 'ops', queued: true });
  row({ id: 'blk1', kind: 'blocked', text: 'Publish v1', stream: 'ops', gate: 'FAKE-3 decision' });
  row({ id: 'don1', kind: 'wip', text: 'Tidy shelf', stream: 'widgets', model: 'claude-opus-5' });
  row({ id: 'dn01', kind: 'done', text: 'Tidy shelf', closes: 'don1', ts: `${DAY}T13:00:00Z` });
  writePrCache(statusDir, { fetchedAt: new Date(NOW.getTime() - 60_000), prs: [raw(12, { createdAt: '2026-10-05T14:00:00Z' } as never), raw(13, { baseRefName: 'staging', title: 'feat: widgets FAKE-12 (staging)', headRefName: 'feat/FAKE-12-x', ci: 'FAILURE', mergeable: 'CONFLICTING' } as never)] });
  writePriorities(statusDir, DAY, [{ text: 'Ship the exporter', stream: 'widgets' }]);
  writeFileSync(join(statusDir, 'ticket-map.json'), JSON.stringify({ 'FAKE-12': ['ask1'] }));
  mkdirSync(join(statusDir, 'fragments'));
  writeFileSync(join(statusDir, 'fragments', 'ops.md'), 'Handover **note**');
  const page = { streams: [], repoStreams: { widgets: 'widgets' }, vaultName: 'sample', trackerUrlBase: 'https://tracker.example.test/browse/', ticketNotePath: 'Tickets/{id}', trackerKeyPattern: 'FAKE-\\d+', tz: 'America/New_York' };
  return { vault, project: 'p', statusDir, page };
}

test('buildState passes the client contract with no dropped rows and carries every section', () => {
  const state = buildState(fixture(), NOW);
  const got = sanitizeState(JSON.parse(JSON.stringify(state)));
  assert.ok(got);
  assert.equal(got.dropped, 0);
  assert.deepEqual(state.streams, ['widgets', 'ops', 'other']);
  assert.equal(state.today, DAY);
  assert.equal(state.asks.length, 1);
  assert.equal(state.working.map((w) => w.id).join(), 'wip1');
  assert.equal(state.queued.map((w) => w.id).join(), 'que1');
  assert.equal(state.blocked[0].gate, 'FAKE-3 decision');
  assert.equal(state.done.map((d) => d.id).join(), 'don1');
  assert.deepEqual(state.priorities, { state: 'ok', date: DAY, items: [{ text: 'Ship the exporter', stream: 'widgets' }] });
  assert.deepEqual(state.fragments, { ops: 'Handover **note**' });
  assert.match(state.seq, /^[0-9a-f]{12}$/);
});

test('an ask is split into the decision and its context, with server-built links', () => {
  const [ask] = buildState(fixture(), NOW).asks;
  assert.equal(ask.needed, 'Merge the exporter PR #12?');
  assert.equal(ask.context, 'CI is green, see FAKE-12.');
  assert.equal(ask.links.note?.url, 'obsidian://open?vault=sample&file=Tickets%2FFAKE-12');
  assert.deepEqual(ask.links.tracker.map((r) => r.url), ['https://tracker.example.test/browse/FAKE-12']);
  assert.deepEqual(ask.links.prs.map((r) => r.label), ['#12']);
});

test('PRs carry their stream, flags, and the develop twin of a staging PR', () => {
  const { prs, prData } = buildState(fixture(), NOW);
  const stg = prs.find((p) => p.number === 13)!;
  assert.equal(stg.twinOf, 12);
  assert.deepEqual(stg.flags, ['CONFLICTING', 'CI FAIL', '1 thr']);
  assert.equal(prs.find((p) => p.number === 12)!.twinOf, undefined);
  assert.equal(prData.stale, false);
});

test('no PR cache, no priorities file and no fragments: empty, not a throw, and PR data is stale', () => {
  const cfg = fixture();
  const bare = { ...cfg, statusDir: join(cfg.vault, 'empty-status') };
  const s = buildState(bare, NOW);
  assert.deepEqual(s.prs, []);
  assert.deepEqual(s.prData, { fetchedAt: null, stale: true });
  assert.deepEqual(s.priorities, { state: 'missing' });
  assert.deepEqual(s.fragments, {});
});

test('a damaged ticket-map.json fails the build loudly instead of rendering a silently different board', () => {
  const cfg = fixture();
  writeFileSync(join(cfg.statusDir, 'ticket-map.json'), '{ nope');
  assert.throws(() => buildState(cfg, NOW), /ticket-map\.json is not valid JSON/);
});

test('an unreadable fragment is a missing fragment', () => {
  const cfg = fixture();
  mkdirSync(join(cfg.statusDir, 'fragments', 'widgets.md'));
  assert.deepEqual(Object.keys(buildState(cfg, NOW).fragments ?? {}), ['ops']);
});

test('a fragment that is a symlink is not followed', () => {
  const cfg = fixture();
  writeFileSync(join(cfg.vault, 'outside.md'), 'TOPSECRET');
  symlinkSync(join(cfg.vault, 'outside.md'), join(cfg.statusDir, 'fragments', 'overview.md'));
  assert.deepEqual(Object.keys(buildState(cfg, NOW).fragments ?? {}), ['ops']);
});

test('a ledger with a malformed line still builds, and warnings go to the callback', () => {
  const cfg = fixture();
  writeFileSync(join(cfg.vault, 'Projects', 'p', 'Journal', 'ledger.jsonl'), 'garbage\n', { flag: 'a' });
  const warnings: string[] = [];
  assert.equal(buildState({ ...cfg, warn: (m) => warnings.push(m) }, NOW).asks.length, 1);
  assert.equal(warnings.length, 1);
});

test('state is read fresh each call: a streams.json edit and a new ask show up on the next call', () => {
  const cfg = fixture();
  assert.ok(!buildState(cfg, NOW).streams.includes('gamma'));
  writeFileSync(join(cfg.vault, 'Projects', 'p', 'streams.json'), JSON.stringify({ streams: { gamma: { aliases: [], status: 'active' } } }));
  openStore({ vault: cfg.vault, project: 'p', dryRun: false }).append({ id: 'ask2', kind: 'question', text: 'Gamma?', stream: 'gamma', ts: `${DAY}T14:00:00Z`, date: DAY });
  const s = buildState(cfg, NOW);
  assert.ok(s.streams.includes('gamma'));
  assert.equal(s.asks.length, 2);
});

test('buildStream narrows every list to one stream and is null for an unknown name', () => {
  const cfg = fixture();
  const ops = buildStream(cfg, 'ops', NOW)!;
  assert.deepEqual([ops.queued.length, ops.blocked.length, ops.asks.length, ops.working.length], [1, 1, 0, 0]);
  assert.deepEqual(Object.keys(ops.fragments ?? {}), ['ops']);
  assert.equal(buildStream(cfg, '../etc', NOW), null);
});

test('buildCharts passes the client contract and counts the day, the ask age, the PR mix and the model', () => {
  const charts = buildCharts(fixture(), 3, NOW);
  const got = sanitizeCharts(JSON.parse(JSON.stringify(charts)));
  assert.equal(got?.dropped, 0);
  assert.deepEqual(got?.data.throughput, charts.throughput);
  assert.deepEqual(got?.data.prMix.byState, charts.prMix.byState);
  assert.deepEqual(charts.days, ['2026-10-04', '2026-10-05', '2026-10-06']);
  assert.deepEqual(charts.throughput[2], { date: DAY, total: 1, byStream: { widgets: 1 }, ids: ['don1'] });
  assert.deepEqual(charts.ageBuckets[0].ids, ['ask1']);
  assert.deepEqual(charts.prMix.byState, { pass: 1, fail: 1 });
  assert.deepEqual(charts.modelMix, { byFamily: { opus: 1 }, source: 'ledger' });
});

test('a paste ask counts the same in the asks list, the footer row and the age chart', () => {
  const cfg = fixture();
  openStore({ vault: cfg.vault, project: 'p', dryRun: false }).append({ id: 'ps01', kind: 'question', text: 'Run the block: it checks', stream: 'widgets', box: 'paste', paste: '/tmp/fake-block.sh', ts: `${DAY}T12:00:00Z`, date: DAY });
  const state = buildState(cfg, NOW);
  const mine = state.asks.filter((a) => a.stream === 'widgets').length;
  assert.equal(mine, 2);
  assert.equal(state.footer.find((f) => f.stream === 'widgets')?.asks, mine);
  assert.equal(buildCharts(cfg, 14, NOW).ageBuckets.reduce((n, b) => n + b.count, 0), state.asks.length);
});

test('the PR mix chart counts only the org PRs when self_review_repos names a repo', () => {
  const cfg = fixture();
  assert.equal(Object.values(buildCharts(cfg, 3, NOW).prMix.byState).reduce((n, c) => n + c, 0), 2);
  const apart = buildCharts({ ...cfg, page: { ...cfg.page, selfReviewRepos: ['acme/widgets'] } }, 3, NOW);
  assert.deepEqual(apart.prMix.byState, {}, 'both fixture PRs are in the self-review repo');
});

test('buildCharts sends done items, PR ages from the cache and the review queue count', () => {
  const cfg = fixture();
  const charts = buildCharts({ ...cfg, page: { ...cfg.page, reviewQueueCap: 4 } }, 3, NOW);
  assert.deepEqual(charts.doneItems.map((d) => [d.id, d.stream, d.text]), [['don1', 'widgets', 'Tidy shelf']]);
  assert.deepEqual(charts.reviewQueue, { count: 2, cap: 4 });
  assert.deepEqual(charts.prAge.buckets.map((b) => b.inQueue.length), [0, 1, 0, 0], 'the PR with a date is one day old');
  assert.deepEqual(charts.prAge.unknownAge.map((p) => p.number), [13], 'the cached PR with no date is listed apart, not counted as new');
  assert.equal(sanitizeCharts(JSON.parse(JSON.stringify(charts)))?.dropped, 0);
});

test('a PR in a self-review repo is out of the review queue count but still in the age chart', () => {
  const cfg = fixture();
  const apart = buildCharts({ ...cfg, page: { ...cfg.page, reviewQueueCap: 4, selfReviewRepos: ['acme/widgets'] } }, 3, NOW);
  assert.deepEqual(apart.reviewQueue, { count: 0, cap: 4 });
  assert.deepEqual(apart.prAge.buckets.map((b) => b.other.length), [0, 1, 0, 0]);
  assert.equal(buildCharts(cfg, 3, NOW).reviewQueue && 'unavailable' in buildCharts(cfg, 3, NOW).reviewQueue, true, 'no cap configured gives a reason, not zero');
});

test('a done item with a ticket in the map links to its note', () => {
  const cfg = fixture();
  writeFileSync(join(cfg.statusDir, 'ticket-map.json'), JSON.stringify({ 'FAKE-12': ['ask1'], 'FAKE-99': ['don1'] }));
  const done = buildCharts(cfg, 3, NOW).doneItems[0];
  assert.equal(done.ticket?.label, 'FAKE-99');
});
