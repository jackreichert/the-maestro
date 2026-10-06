// Run: node --test scripts/lib/web/state.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState, PR_STALE_MS } from './state.ts';
import type { GatheredInputs } from '../status-page/generate.ts';
import type { PageConfig, Pr } from '../status-page/render.ts';

const NOW = new Date('2026-10-06T15:00:00Z');
const CONFIG: PageConfig = {
  streams: ['Alpha'], repoStreams: { 'acme-widgets': 'Alpha', gadgets: 'Beta' }, vaultName: 'Vault', trackerUrlBase: 'https://tracker.test/browse/',
  ticketNotePath: 'Projects/{prefix}/Tickets/{id}', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'America/New_York',
};
const pr = (number: number, over: Partial<Pr> = {}): Pr => ({
  number, title: `feat: thing ${number} FAKE-${number}`, url: `https://example.test/acme-widgets/pull/${number}`, isDraft: false, baseRefName: 'develop', headRefName: `feat/FAKE-${number}`,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, repo: 'org/acme-widgets', short: 'acme-widgets', owner: 'org', unresolved: 0, ci: 'SUCCESS', stream: 'Alpha', ...over,
});
const inputs = (over: Partial<GatheredInputs> = {}): GatheredInputs => ({
  now: NOW,
  status: {
    inflight: [{ id: 'aa11', date: '2026-10-06', ts: '2026-10-06T14:00:00Z', text: 'building FAKE-1 now', stream: 'Alpha', model: 'opus' }],
    queued: [{ id: 'qq11', date: '2026-10-06', text: 'later', stream: 'Unregistered' }],
    blocked: [{ id: 'bl11', date: '2026-10-05', text: 'waiting on review', stream: 'Beta' }],
    awaiting: [
      { id: 'bb22', date: '2026-10-05', ts: '2026-10-05T12:00:00Z', text: 'Merge widgets #12 now? See FAKE-12 and https://x.test/y for context', stream: 'Alpha' },
      { id: 'cc33', date: '2026-10-01', text: 'old question with no mark', stream: 'Gamma' },
    ],
    done: [{ id: 'dd44', date: '2026-10-06', ts: '2026-10-06T13:00:00Z', text: 'shipped', stream: 'Alpha', closedBy: { ts: '2026-10-06T13:30:00Z' } } as never],
    footer: { ledger: [{ name: 'Alpha', done: 1, inflight: 1, queued: 0, awaiting: 1, paste: 0, blocked: 0 }], session: { available: false } as never },
  },
  triage: { items: [
    { id: 'bb22', date: '2026-10-05', text: '', ticket: 'proj-7' }, { id: 'bl11', date: '2026-10-05', text: '', gate: 'gh:pr:gadgets#2' },
    { id: 'df55', date: '2026-10-02', text: 'park this', stream: 'Alpha', deferredUntil: '2026-10-20' },
  ] },
  prs: [pr(12), pr(13, { baseRefName: 'staging', headRefName: 'feat/FAKE-12-staging', title: 'feat: thing 12 FAKE-12 (staging)', ci: 'FAILURE', unresolved: 1 }), pr(14, { baseRefName: 'feat/FAKE-12', headRefName: 'feat/FAKE-14' })],
  prData: { fetchedAt: new Date('2026-10-06T14:55:00Z') },
  ticketMap: { 'proj-9': ['aa11'] },
  priorities: { state: 'ok', date: '2026-10-06', items: [{ text: 'Get widgets out', stream: 'Alpha' }] },
  config: CONFIG, ...over,
});

test('state carries freshness, the page day, display order with other last, and the footer counts', () => {
  const s = buildState(inputs());
  assert.equal(s.generatedAt, '2026-10-06T15:00:00.000Z');
  assert.equal(s.today, '2026-10-06');
  assert.deepEqual(s.streams, ['Alpha', 'Beta', 'Gamma', 'Unregistered', 'other']);
  assert.equal(s.footer[0]?.name, 'Alpha');
  assert.deepEqual(s.prData, { fetchedAt: '2026-10-06T14:55:00.000Z', stale: false });
  assert.equal(s.priorities.state, 'ok');
});

test('PR data is stale when old or never read, and carries the failure text when the last read failed', () => {
  assert.equal(buildState(inputs({ prData: { fetchedAt: new Date(NOW.getTime() - PR_STALE_MS - 1) } })).prData.stale, true);
  assert.deepEqual(buildState(inputs({ prData: { fetchedAt: null, failure: 'gh down' } })).prData, { fetchedAt: null, stale: true, failure: 'gh down' });
});

test('an ask splits into the decision and its context, with the age, the triage ticket note and tracker and PR links as data', () => {
  const [ask, old] = buildState(inputs()).asks;
  assert.equal(ask?.needed, 'Merge widgets #12 now?');
  assert.equal(ask?.context, 'See FAKE-12 and for context');
  assert.equal(ask?.ageDays, 1);
  assert.equal(ask?.stream, 'Alpha');
  assert.equal(ask?.links.note?.label, 'proj-7');
  assert.match(ask?.links.note?.url ?? '', /^obsidian:\/\//);
  assert.deepEqual(ask?.links.tracker, [{ label: 'FAKE-12', url: 'https://tracker.test/browse/FAKE-12' }]);
  assert.deepEqual(ask?.links.prs, [{ label: '#12', url: 'https://example.test/acme-widgets/pull/12' }]);
  assert.equal(old?.ageDays, 5);
  assert.equal(old?.stream, 'Gamma');
  assert.deepEqual(old?.links, { tracker: [], prs: [] });
});

test('an ask written at 8:30 pm Eastern on the 5th, seen at 9 pm, is 0 days old, not -1 from its UTC date', () => {
  const base = inputs();
  const s = buildState(inputs({ now: new Date('2026-10-06T01:00:00Z'), status: { ...base.status, awaiting: [{ id: 'ev01', date: '2026-10-06', ts: '2026-10-06T00:30:00Z', text: 'evening question?', stream: 'Alpha' }] } }));
  assert.equal(s.today, '2026-10-05');
  assert.equal(s.asks[0]?.ageDays, 0);
});

test('priorities and footer are copies: changing the state never changes the inputs', () => {
  const i = inputs();
  const s = buildState(i);
  s.footer[0]!.done = 99;
  if (s.priorities.state === 'ok') s.priorities.items.push({ text: 'x' });
  assert.equal(i.status.footer?.ledger[0]?.done, 1);
  assert.equal(i.priorities.state === 'ok' ? i.priorities.items.length : -1, 1);
});

test('an item whose stream is not in the display order is filed under other', () => {
  const s = buildState(inputs({ status: { ...inputs().status, awaiting: [{ id: 'zz99', date: '2026-10-06', text: 'no stream here?' }] } }));
  assert.equal(s.asks[0]?.stream, 'other');
});

test('in-flight, queued, blocked, done and deferred items carry stream, ticket, links and the times the page needs', () => {
  const s = buildState(inputs());
  assert.equal(s.working[0]?.ticket, 'proj-9');
  assert.deepEqual(s.working[0]?.links.map((l) => l.label), ['proj-9', 'FAKE-1']);
  assert.equal(s.working[0]?.model, 'opus');
  assert.equal(s.working[0]?.since, '2026-10-06T14:00:00Z');
  assert.equal(s.queued[0]?.stream, 'Unregistered');
  assert.equal(s.blocked[0]?.gate, 'gh:pr:gadgets#2');
  assert.equal(s.done[0]?.closedAt, '2026-10-06T13:30:00Z');
  assert.deepEqual(s.deferred.map((d) => [d.id, d.until]), [['df55', '2026-10-20']]);
});

test('open PRs come per stream in table order with flags as data, the staging twin pointing at its develop PR and a stacked PR at its parent', () => {
  const s = buildState(inputs());
  assert.deepEqual(s.prs.map((p) => [p.number, p.twinOf, p.stackedOn, p.flags]), [[12, undefined, undefined, []], [13, 12, undefined, ['CI FAIL', '1 thr']], [14, undefined, 12, []]]);
  assert.equal(s.prs[1]?.base, 'staging');
  assert.equal(s.prs[0]?.review, null);
});

test('state is JSON-safe plain data and a pure function of its input (no HTML, no shared state between calls)', () => {
  const a = buildState(inputs());
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  assert.deepEqual(buildState(inputs()), a);
  assert.equal(JSON.stringify(a).includes('<span'), false);
});
