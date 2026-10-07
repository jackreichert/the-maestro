// Run: node --test scripts/lib/home/build.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReader } from '../vault/reader.ts';
import { loadTickets, TICKET_DIR_SCOPES, TICKET_FILE_SCOPES } from '../vault/tickets.ts';
import fs from 'node:fs';
import { assertNoCanary, buildFixture } from '../vault/fixture.ts';
import type { PageConfig } from '../status-page/render.ts';
import { validateHomes } from './config.ts';
import { buildStreamHome } from './build.ts';
import { DOC_DIR_SCOPES, DOC_FILE_SCOPES, loadDocs } from './docs.ts';
import type { HomeInput, LedgerFact } from './build.ts';

const NOW = new Date('2026-10-07T12:00:00Z');
const PAGE: PageConfig = { streams: [], repoStreams: {}, vaultName: 'Vault', trackerUrlBase: 'https://tracker.test/browse/', ticketNotePath: '', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'UTC' };
const STREAMS = ['Avonlea', 'Green Gables'];
const fx = buildFixture();
const READER = createReader({ root: fx.root, dirScopes: [...TICKET_DIR_SCOPES, ...DOC_DIR_SCOPES], fileScopes: [...TICKET_FILE_SCOPES, ...DOC_FILE_SCOPES] });
const vault = loadTickets(READER, fx.root);

function input(over: Partial<HomeInput> & { config?: object; ledger?: LedgerFact[] } = {}): HomeInput {
  const { config, ...rest } = over;
  return { stream: 'Avonlea', streams: STREAMS, now: NOW, vault, homes: validateHomes({ version: 1, streams: config ?? { Avonlea: { epics: ['avonlea-api-042'] } } }, STREAMS), ledger: [], prs: [], prData: { fetchedAt: new Date('2026-10-07T11:55:00Z') }, page: PAGE, readDocs: (p) => loadDocs(READER, p), readBrief: () => ({ ok: false, reason: 'missing' }), ...rest };
}

test('an epic reports honest counts with their units, and the numbers add up to its total', () => {
  const h = buildStreamHome(input({ ledger: [{ id: 'ask1', ticket: 'avonlea-api-045', state: 'ask', stream: 'Avonlea' }] }));
  const e = h.epics.find((x) => x.id === 'avonlea-api-042');
  assert.ok(e);
  assert.deepEqual([e.total, e.closed, e.inProgress, e.blocked, e.notStarted], [10, 4, 1, 2, 3]);
  assert.equal(e.closed + e.inProgress + e.blocked + e.notStarted, e.total, 'closed plus the three open buckets is the total');
  assert.deepEqual(e.verify, { required: false, verified: 1 });
  assert.equal(e.points, null, '4 of 6 open tickets pointed is under 80 percent');
  assert.equal(e.awaiting, 1);
  assert.equal(e.next?.id, 'avonlea-api-045');
  assert.equal(e.next?.awaitsYou, true);
  assert.equal(e.next?.quietDays, 36);
  assert.equal(e.tracker?.url, 'https://tracker.test/browse/AV-1201', 'jira- prefix dropped');
  assert.equal(e.note.url, 'obsidian://open?vault=Vault&file=Projects%2Favonlea-api%2FTickets%2Favonlea-api-042');
  assert.deepEqual(h.mapping, { source: 'config', configFound: true });
});

test('what is left is grouped, a ticket appears once, and an unresolved blocked-by makes an open ticket blocked', () => {
  const h = buildStreamHome(input());
  assert.deepEqual(h.left.inProgress.map((r) => r.id), ['avonlea-api-045']);
  assert.deepEqual(h.left.blocked.map((r) => r.id), ['avonlea-api-046', 'avonlea-api-047']);
  assert.deepEqual(h.left.notStarted.map((r) => r.id), ['avonlea-api-048', 'avonlea-api-050', 'avonlea-api-052']);
  assert.equal(h.left.truncated, 0);
  const all = [...h.left.inProgress, ...h.left.blocked, ...h.left.notStarted].map((r) => r.id);
  assert.equal(new Set(all).size, all.length);
});

test('a ledger item in flight moves an open ticket to in progress, a blocked one to blocked', () => {
  const h = buildStreamHome(input({ ledger: [{ id: 'w1', ticket: 'avonlea-api-052', state: 'inflight' }, { id: 'b1', ticket: 'avonlea-api-050', state: 'blocked' }] }));
  assert.ok(h.left.inProgress.some((r) => r.id === 'avonlea-api-052'));
  assert.ok(h.left.blocked.some((r) => r.id === 'avonlea-api-050'));
});

test('points-weighted progress appears only when 80 percent of open tickets are pointed, otherwise an unknown says why', () => {
  const sparse = buildStreamHome(input());
  assert.ok(sparse.unknowns.some((u) => u.kind === 'sparse-points' && /4 of 6 open tickets are pointed/.test(u.text)));
  assert.ok(sparse.unknowns.some((u) => u.kind === 'big-points' && /avonlea-api-050/.test(u.text)));
  const gg = buildStreamHome(input({ stream: 'Green Gables', config: { 'Green Gables': { epics: ['green-gables-001'] } } }));
  assert.equal(gg.epics[0]?.points, null);
});

test('a verify-required epic counts verified apart from closed and lists what is closed but not verified', () => {
  const h = buildStreamHome(input({ config: { Avonlea: { epics: ['avonlea-api-042'], done: { 'avonlea-api-042': 'verified' } } } }));
  const e = h.epics[0];
  assert.deepEqual([e?.closed, e?.verify], [4, { required: true, verified: 1 }]);
  const u = h.unknowns.find((x) => x.kind === 'closed-not-verified');
  assert.match(u?.text ?? '', /avonlea-api-044, avonlea-api-049, avonlea-api-051/);
  assert.equal(e?.unknowns, h.unknowns.filter((x) => x.epic === 'avonlea-api-042').length);
});

test('done means is the epic section as plain text, and an epic without one is an unknown, not a guess', () => {
  const h = buildStreamHome(input({ config: { Avonlea: { epics: ['avonlea-api-042'] }, 'Green Gables': { epics: ['green-gables-001'] } } }));
  assert.deepEqual(h.doneMeans, [{ epic: 'avonlea-api-042', text: 'The new pipeline is primary for seven days. Nothing reads the old one.' }]);
  const gg = buildStreamHome(input({ stream: 'Green Gables', config: { 'Green Gables': { epics: ['green-gables-001'] } } }));
  assert.ok(gg.unknowns.some((u) => u.kind === 'no-done-means' && u.epic === 'green-gables-001'));
});

test('ledger and ticket that disagree, missing parents, loops and tracker keys are unknowns', () => {
  const h = buildStreamHome(input({ ledger: [{ id: 'd1', ticket: 'avonlea-api-052', state: 'done' }, { id: 'o1', ticket: 'avonlea-api-043', state: 'inflight' }] }));
  const texts = h.unknowns.filter((u) => u.kind === 'ledger-ticket').map((u) => u.text);
  assert.deepEqual(texts, ['avonlea-api-052: ledger item d1 says done, the ticket is still open.', 'avonlea-api-043: closed here, but ledger item o1 is still open.']);
  assert.ok(h.unknowns.some((u) => u.kind === 'tracker-unread' && /2 linked tracker keys/.test(u.text)));
  assert.ok(!h.unknowns.some((u) => u.kind === 'parent-cycle'), 'a loop in a project the stream does not own is not its business');
  const owns = buildStreamHome(input({ config: { Avonlea: { epics: ['avonlea-api-042'], projects: ['loop-lab'] } } }));
  assert.ok(owns.unknowns.some((u) => u.kind === 'parent-cycle' && /loop-lab-00/.test(u.text)));
});

test('files the reader refused are unknowns with vault-relative paths, and no canary or absolute path reaches the output', () => {
  const h = buildStreamHome(input());
  const refused = h.unknowns.filter((u) => u.kind === 'unreadable-note').map((u) => u.text).sort();
  assert.ok(refused.some((t) => /huge\.md: too-large/.test(t)) && refused.some((t) => /locked\.md: unreadable/.test(t)));
  const out = JSON.stringify(h);
  assertNoCanary(out);
  assert.ok(!out.includes(fx.root) && !out.includes(fx.outside));
});

test('an ambiguous epic is named on every stream it touches and claimed by neither', () => {
  const links = (s: string, t: string): LedgerFact => ({ id: `${s}${t}`, ticket: t, state: 'other', stream: s });
  const ledger = [links('Avonlea', 'avonlea-api-045'), links('Green Gables', 'avonlea-api-043')];
  for (const stream of STREAMS) {
    const h = buildStreamHome(input({ stream, config: {}, ledger }));
    assert.ok(h.unknowns.some((u) => u.kind === 'ambiguous-epic' && u.epic === 'avonlea-api-042'), stream);
    assert.ok(!h.epics.some((e) => e.id === 'avonlea-api-042'));
  }
});

test('a stream with no epic gets no progress at all, and no vault root is one unknown', () => {
  const h = buildStreamHome(input({ stream: 'Green Gables', config: {} }));
  assert.ok(h.epics.every((e) => e.id !== 'avonlea-api-042'));
  const none = buildStreamHome(input({ vault: null }));
  assert.deepEqual([none.epics, none.left.notStarted, none.unknowns.map((u) => u.kind)], [[], [], ['no-vault']]);
});

test('invalid config entries become unknowns, the page still builds, and seq changes with the content', () => {
  const bad = input({ homes: validateHomes({ version: 1, streams: { Avonlea: { epics: ['avonlea-api-042'], pins: [{ label: 'x', url: 'javascript:1' }] } } }, STREAMS) });
  const h = buildStreamHome(bad);
  assert.ok(h.unknowns.some((u) => u.kind === 'config-invalid' && /pins\[0\]/.test(u.text)));
  assert.notEqual(h.seq, buildStreamHome(input()).seq);
  assert.equal(buildStreamHome(input()).seq, buildStreamHome(input()).seq);
});

test('PR data freshness is reported, stale after 15 minutes or when never read', () => {
  assert.equal(buildStreamHome(input()).freshness.prs.stale, false);
  assert.equal(buildStreamHome(input({ prData: { fetchedAt: new Date('2026-10-07T11:00:00Z') } })).freshness.prs.stale, true);
  assert.deepEqual(buildStreamHome(input({ prData: { fetchedAt: null } })).freshness.prs, { fetchedAt: null, stale: true });
});

test('a nested epic listed for another stream is not counted in its parent epic or its left list', () => {
  const both = { Avonlea: { epics: ['avonlea-api-042'] }, 'Green Gables': { epics: ['avonlea-api-048'] } };
  const a = buildStreamHome(input({ config: both }));
  const parent = a.epics.find((e) => e.id === 'avonlea-api-042');
  assert.deepEqual([parent?.total, parent?.closed], [7, 3], '10 tickets less the nested epic and its 2 children (1 closed)');
  assert.ok(![...a.left.inProgress, ...a.left.blocked, ...a.left.notStarted].some((r) => ['avonlea-api-048', 'avonlea-api-050'].includes(r.id)));
  const g = buildStreamHome(input({ stream: 'Green Gables', config: both }));
  assert.deepEqual(g.epics.filter((e) => e.id.startsWith('avonlea')).map((e) => [e.id, e.total, e.closed]), [['avonlea-api-048', 2, 1]]);
});

test('something that really blocks a ticket wins over its in-progress status', () => {
  const h = buildStreamHome(input({ ledger: [{ id: 'b1', ticket: 'avonlea-api-045', state: 'blocked' }] }));
  assert.ok(h.left.blocked.some((r) => r.id === 'avonlea-api-045') && !h.left.inProgress.some((r) => r.id === 'avonlea-api-045'));
  const e = h.epics[0];
  assert.equal((e?.inProgress ?? 0) + (e?.blocked ?? 0) + (e?.notStarted ?? 0) + (e?.closed ?? 0), e?.total);
});

test('a vault that cannot be read is an unknown on every stream, never a quiet empty page', () => {
  const broken = { tickets: [], issues: [{ kind: 'unreadable-folder' as const, text: 'Projects: cannot be read', path: 'Projects' }], projects: [], newestMtime: 0 };
  const h = buildStreamHome(input({ vault: broken, config: {} }));
  assert.ok(h.unknowns.some((u) => u.kind === 'unreadable-note' && /Projects: cannot be read/.test(u.text)));
});

test('a configured epic that is not in the vault is named, and a differently cased heading still counts', () => {
  const h = buildStreamHome(input({ config: { Avonlea: { epics: ['avonlea-api-042', 'avonlea-api-777'] } } }));
  assert.ok(h.unknowns.some((u) => u.kind === 'config-invalid' && /avonlea-api-777/.test(u.text)));
  fx.write('Projects/avonlea-api/Tickets/avonlea-api-042.md', fs.readFileSync(`${fx.root}/Projects/avonlea-api/Tickets/avonlea-api-042.md`, 'utf8').replace('## What done looks like', '## What Done Looks Like'));
  const again = buildStreamHome(input({ vault: loadTickets(READER, fx.root) }));
  assert.equal(again.doneMeans.length, 1);
});
