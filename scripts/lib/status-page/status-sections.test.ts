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
  streams: ['Team Select', 'Bayada'], repoStreams: {}, vaultName: 'Vault', trackerUrlBase: 'https://tracker.test/browse/',
  ticketNotePath: 'Projects/{prefix}/Tickets/{id}', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'America/New_York',
};
const row = (id: string, kind: string, text: string, over: Partial<LedgerRow> = {}): LedgerRow =>
  ({ id, kind, ts: `${TODAY}T13:00:00Z`, date: TODAY, text, ...over }) as LedgerRow;
const rows: LedgerRow[] = [
  row('aa11', 'wip', 'wire the partner api FAKE-1', { stream: 'Team Select', model: 'Model A', ts: `${TODAY}T11:00:00Z` }),
  row('aa12', 'wip', 'second team select job', { stream: 'Team Select', model: 'Model B' }),
  row('bb21', 'wip', 'direct integration', { stream: 'Bayada', model: 'Model A', ts: `${TODAY}T14:30:00Z` }),
  row('cc31', 'wip', 'loose job'),
  row('dd41', 'question', 'which path?', { stream: 'Bayada' }),
  row('ee51', 'blocked', 'waiting on a vendor', { stream: 'Team Select' }),
  row('ff61', 'question', 'run this', { stream: 'Bayada', paste: '/tmp/fake.sh' }),
  row('gg71', 'wip', 'shipped thing', { stream: 'Bayada' }),
  row('hh81', 'done', 'shipped', { closes: 'gg71', stream: 'Bayada' }),
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
    inflight: g.inflight, blocked: g.blocked, awaiting: g.awaiting, done,
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
    const m = l.match(/^\*\*Ledger \((.+)\):\*\* (\d+) done today · (\d+) in flight · (\d+) awaiting you(?: · (\d+) to run)?(?: · (\d+) blocked)?$/);
    assert.ok(m, l);
    return [m[1], m[2], m[3], m[4], m[5] ?? '0', m[6] ?? '0'];
  });
  assert.deepEqual(rowsOnPage, fromFooter);
  assert.deepEqual(rowsOnPage.map((r) => r[0]), ['Team Select', 'Bayada', 'other'], 'Team Select and Bayada stay separate streams');
  assert.deepEqual(rowsOnPage.find((r) => r[0] === 'Bayada'), ['Bayada', '1', '1', '1', '1', '0']);
});

test('the Status section ends with the agents line and the session line formatted as the footer formats it', () => {
  const b = board();
  const s = section(page(b), '## Status');
  assert.ok(s.includes('**Agents:** 4 in flight on the ledger (the live agent roster is shown in each reply\'s footer)'));
  assert.ok(s.includes(sessionText(b.footer!.session)));
  assert.ok(s.includes('**Session:** 86 turns (47% of 180 roll) · 129k read/turn · roll soon'));
  assert.equal(section(page(b), '## Status').length > 0 && page(b).trimEnd().split('\n').includes('## Status'), true);
});

test('Working on now sits directly under the priorities, grouped by stream, with model and running time', () => {
  const p = page(board());
  const lines = p.split('\n');
  const pri = lines.indexOf("## Today's priorities");
  const work = lines.indexOf('## Working on now (4)');
  assert.ok(pri !== -1 && work > pri);
  assert.ok(!lines.slice(pri + 1, work).some((l) => /^## /.test(l)), 'no section between the priorities and Working on now');
  const t = section(p, '## Working on now (4)').filter((l) => l.startsWith('| ')).slice(1).map(cells);
  assert.deepEqual(t.map((r) => [r[0], r[1]]), [['Team Select', '`aa11`'], ['Team Select', '`aa12`'], ['Bayada', '`bb21`'], ['other', '`cc31`']]);
  assert.equal(t[0]?.[3], '[FAKE-1](https://tracker.test/browse/FAKE-1)');
  assert.equal(t[0]?.[4], 'Model A');
  assert.equal(t[0]?.[5], '4 h (since 7:00 am ET)');
  assert.equal(t[2]?.[5], '30 min (since 10:30 am ET)');
});

test('with nothing in flight and no footer data the sections say so instead of vanishing', () => {
  const p = page({ inflight: [], blocked: [], awaiting: [], done: [] });
  assert.ok(section(p, '## Working on now (0)').includes('Nothing in flight.'));
  assert.match(p, /\*\*Footer data unavailable:\*\*/);
});

test('the new sections are not answer areas: no id, tick or answer is read from them', () => {
  const p = page(board());
  const without = p.split('\n').filter((l) => !section(p, '## Working on now (4)').includes(l) && !section(p, '## Status').includes(l)).join('\n');
  assert.deepEqual(extractFields(p), extractFields(without), 'the fields come only from the asks and the priorities');
  assert.deepEqual(Object.keys(extractFields(p).ticks), ['dd41'], 'the one ask on the board, not an in-flight id');
  const typed = p.replace('**Session:**', '> answer: nope\n**Session:**');
  assert.deepEqual(extractFields(typed).answers, {}, 'an answer typed under Status belongs to no ask');
});
