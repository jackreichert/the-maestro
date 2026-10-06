// Run: node --test scripts/lib/status-page/status-sections.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, mapStreamWith } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { parseArgs } from '../journal/args.ts';
import { footerLines, footerRows, groups } from '../journal/board.ts';
import type { BoardContext } from '../journal/board.ts';
import { sessionText } from '../session-text.ts';
import type { SessionStatus } from '../session-text.ts';
import { extractFields } from './inline.ts';
import { renderPage } from './render.ts';
import type { BoardStatus, PageConfig, PageInput } from './render.ts';

const TODAY = '2026-10-05';
const NOW = new Date('2026-10-05T15:00:00Z');
const CONFIG: PageConfig = {
  streams: ['Rivendell', 'Narnia'], repoStreams: {}, vaultName: 'Vault', trackerUrlBase: 'https://tracker.test/browse/',
  ticketNotePath: 'Projects/{prefix}/Tickets/{id}', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'America/New_York',
};
const row = (id: string, kind: string, text: string, over: Partial<LedgerRow> = {}): LedgerRow =>
  ({ id, kind, ts: `${TODAY}T13:00:00Z`, date: TODAY, text, ...over }) as LedgerRow;
const rows: LedgerRow[] = [
  row('aa11', 'wip', 'wire the partner api FAKE-1', { stream: 'Rivendell', model: 'Model A', ts: `${TODAY}T11:00:00Z` }),
  row('aa12', 'wip', 'second rivendell job', { stream: 'Rivendell', model: 'Model B' }),
  row('bb21', 'wip', 'direct integration', { stream: 'Narnia', model: 'Model A', ts: `${TODAY}T14:30:00Z` }),
  row('cc31', 'wip', 'loose job'),
  row('dd41', 'question', 'which path?', { stream: 'Narnia' }),
  row('ee51', 'blocked', 'waiting on a vendor', { stream: 'Rivendell' }),
  row('ff61', 'question', 'run this', { stream: 'Narnia', paste: '/tmp/fake.sh' }),
  row('qq91', 'wip', 'later rivendell job FAKE-9', { stream: 'Rivendell', queued: true, ts: `${TODAY}T12:00:00Z` }),
  row('qq92', 'wip', 'later narnia job', { stream: 'Narnia', queued: true, ts: `${TODAY}T14:00:00Z` }),
  row('qq93', 'wip', 'parked after starting', { stream: 'Rivendell', ts: `${TODAY}T10:00:00Z` }),
  row('qq94', 'queue', 'queue', { queues: 'qq93', ts: `${TODAY}T14:50:00Z` }),
  row('qq95', 'wip', 'started from the queue', { stream: 'Narnia', queued: true, ts: `${TODAY}T09:00:00Z` }),
  row('qq96', 'promote', 'start', { promotes: 'qq95', ts: `${TODAY}T14:00:00Z` }),
  row('gg71', 'wip', 'shipped thing', { stream: 'Narnia' }),
  row('hh81', 'done', 'shipped', { closes: 'gg71', stream: 'Narnia' }),
];

/** Board groups over the in-memory rows, the way `journal.ts status` builds them. */
function board(): BoardStatus & { footerText: string[] } {
  const ctx: BoardContext = {
    readLedger: () => rows, fold: (e) => fold(e, null), today: () => TODAY, rollPoint: () => undefined,
    has: parseArgs(['status']).has, mapStream: (s) => mapStreamWith(null, s), loadRegistry: () => null, ensureDir: () => {}, dir: '', dryRun: true,
  };
  const g = groups(ctx);
  const done = g.doneOn(TODAY, { sinceRoll: true });
  const session: SessionStatus = { available: true, turns: 86, pct: 47, rollTurns: 180, readK: 129, advice: 'roll soon' };
  return {
    inflight: g.inflight, queued: g.queued, blocked: g.blocked, awaiting: g.awaiting, done,
    footer: { ledger: footerRows(g, done), session }, footerText: footerLines(g, done),
  } as BoardStatus & { footerText: string[] };
}

const page = (status: BoardStatus): string => {
  const input: PageInput = { now: NOW, status, triage: { items: [] }, prs: [], prData: { fetchedAt: NOW }, ticketMap: {}, priorities: { state: 'ok', date: TODAY, items: [{ text: 'Ship it' }] }, config: CONFIG, command: 'journal.ts status-page' };
  return renderPage(input).page;
};
const section = (p: string, heading: string): string[] => {
  const lines = p.split('\n');
  const at = lines.indexOf(heading);
  const end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  return lines.slice(at, end === -1 ? undefined : end);
};
const cells = (l: string): string[] => l.split('|').slice(1, -1).map((c) => c.trim());

test('the Status table carries exactly the numbers status --footer prints, one row per stream', () => {
  const b = board();
  const rowsOnPage = section(page(b), '## Status').filter((l) => l.startsWith('| ')).slice(1).map(cells);
  const fromFooter = b.footerText.map((l) => {
    const m = l.match(/^\*\*Ledger \((.+)\):\*\* (\d+) done today · (\d+) in flight(?: · (\d+) queued)? · (\d+) awaiting you(?: · (\d+) to run)?(?: · (\d+) blocked)?$/);
    assert.ok(m, l);
    return [m[1], m[2], m[3], m[4] ?? '0', m[5], m[6] ?? '0', m[7] ?? '0'];
  });
  assert.deepEqual(rowsOnPage, fromFooter);
  assert.deepEqual(rowsOnPage.map((r) => r[0]), ['Rivendell', 'Narnia', 'other'], 'Rivendell and Narnia stay separate streams');
  assert.deepEqual(rowsOnPage.find((r) => r[0] === 'Narnia'), ['Narnia', '1', '2', '1', '1', '1', '0']);
});

test('the Status section ends with the agents line and the session line formatted as the footer formats it', () => {
  const b = board();
  const s = section(page(b), '## Status');
  assert.ok(s.includes('**Agents:** 5 in flight on the ledger (the live agent roster is shown in each reply\'s footer)'));
  assert.ok(s.includes(sessionText(b.footer!.session)));
  assert.ok(s.includes('**Session:** 86 turns (47% of 180 roll) · 129k read/turn · roll soon'));
  assert.equal(section(page(b), '## Status').length > 0 && page(b).trimEnd().split('\n').includes('## Status'), true);
});

test('Working on now sits directly under the priorities, grouped by stream, with model and running time', () => {
  const p = page(board());
  const lines = p.split('\n');
  const pri = lines.indexOf("## Today's priorities");
  const work = lines.indexOf('## Working on now (5)');
  assert.ok(pri !== -1 && work > pri);
  assert.ok(!lines.slice(pri + 1, work).some((l) => /^## /.test(l)), 'no section between the priorities and Working on now');
  const t = section(p, '## Working on now (5)').filter((l) => l.startsWith('| ')).slice(1).map(cells);
  assert.deepEqual(t.map((r) => [r[0], r[1]]), [['Rivendell', '`aa11`'], ['Rivendell', '`aa12`'], ['Narnia', '`bb21`'], ['Narnia', '`qq95`'], ['other', '`cc31`']]);
  assert.equal(t[0]?.[3], '[FAKE-1](https://tracker.test/browse/FAKE-1)');
  assert.equal(t[0]?.[4], 'Model A');
  assert.equal(t[0]?.[5], '4 h (since 7:00 am ET)');
  assert.equal(t[2]?.[5], '30 min (since 10:30 am ET)');
  assert.equal(t[3]?.[5], '1 h (since 10:00 am ET)', 'a promoted item runs from its start, not from when it was queued at 5:00 am ET');
  assert.ok(!t.some((r) => /qq9[123]/.test(r[1] ?? '')), 'queued items are not working on now');
});

test('Queued sits right after Working on now, grouped by stream, with ticket link and age, and holds only queued items', () => {
  const p = page(board());
  const lines = p.split('\n');
  assert.equal(lines.findIndex((l) => l.startsWith('## Queued (')), lines.findIndex((l, i) => i > lines.indexOf('## Working on now (5)') && /^## /.test(l)), 'the next section after Working on now');
  const q = section(p, '## Queued (3)');
  assert.ok(q.length > 0);
  const t = q.filter((l) => l.startsWith('| ')).slice(1).map(cells);
  assert.deepEqual(t.map((r) => [r[0], r[1]]), [['Rivendell', '`qq91`'], ['Rivendell', '`qq93`'], ['Narnia', '`qq92`']]);
  assert.equal(t[0]?.[3], '[FAKE-9](https://tracker.test/browse/FAKE-9)');
  assert.equal(t[0]?.[4], '3 h');
  assert.equal(t[1]?.[4], '10 min', 'an item parked after it started waits from the moment it was queued');
  assert.equal(t[2]?.[4], '1 h');
});

test('Queued says so when empty, and is not an answer area', () => {
  assert.ok(section(page({ inflight: [], queued: [], blocked: [], awaiting: [], done: [] }), '## Queued (0)').includes('Nothing queued.'));
  const p = page(board());
  assert.deepEqual(Object.keys(extractFields(p).ticks), ['dd41'], 'a queued id is not a tick');
});

test('with nothing in flight and no footer data the sections say so instead of vanishing', () => {
  const p = page({ inflight: [], queued: [], blocked: [], awaiting: [], done: [] });
  assert.ok(section(p, '## Working on now (0)').includes('Nothing in flight.'));
  assert.match(p, /\*\*Footer data unavailable:\*\*/);
});

test('the new sections are not answer areas: no id, tick or answer is read from them', () => {
  const p = page(board());
  const without = p.split('\n').filter((l) => !section(p, '## Working on now (5)').includes(l) && !section(p, '## Status').includes(l)).join('\n');
  assert.deepEqual(extractFields(p), extractFields(without), 'the fields come only from the asks and the priorities');
  assert.deepEqual(Object.keys(extractFields(p).ticks), ['dd41'], 'the one ask on the board, not an in-flight id');
  const typed = p.replace('**Session:**', '> answer: nope\n**Session:**');
  assert.deepEqual(extractFields(typed).answers, {}, 'an answer typed under Status belongs to no ask');
});

test('an ask with emphasis markers renders as one intact bold span, so what the page shows is what status-watch reads', () => {
  const asks = [
    row('mk01', 'question', 'Merge **now**? context after', { stream: 'Narnia' }),
    row('mk02', 'question', '*Ship* it*? ok', { stream: 'Narnia' }),
    row('mk03', 'question', 'Use snake_case_name and `code`? later', { stream: 'Narnia' }),
  ];
  const saved = rows.splice(0, rows.length, ...asks);
  try {
    const lines = section(page(board()), '## Needs attention now (3)').filter((l) => l.startsWith('- [ ]'));
    assert.match(lines[0] as string, /`mk01` \*\*Merge \\\*\\\*now\\\*\\\*\?\*\* context after/);
    assert.match(lines[1] as string, /`mk02` \*\*\\\*Ship\\\* it\\\*\?\*\* ok/);
    assert.match(lines[2] as string, /`mk03` \*\*Use snake\\_case\\_name and \\`code\\`\?\*\* later/);
  } finally { rows.splice(0, rows.length, ...saved); }
});

test('a single long token with no space is clipped with the ellipsis and loses no extra character', () => {
  const token = 'x'.repeat(200);
  const saved = rows.splice(0, rows.length, row('lt01', 'wip', token, { stream: 'Narnia' }));
  try {
    const line = section(page(board()), '## Working on now (1)').find((l) => l.includes('`lt01`')) as string;
    assert.ok(line.includes(`${'x'.repeat(107)}...`) && !line.includes('x'.repeat(108)), 'exactly 107 characters then the ellipsis');
  } finally { rows.splice(0, rows.length, ...saved); }
});
