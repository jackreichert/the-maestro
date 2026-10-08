// Run: node --test scripts/lib/start/start-here.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { START_MAX_LINES, buildStart, homeCounts, previousWorkingDay, startLines } from './start-here.ts';
import type { StartOptions } from './start-here.ts';
import type { Groups } from '../journal/board.ts';
import type { LedgerItem } from '../ledger-core.ts';
import type { StreamHome } from '../home/types.ts';

const NOW = new Date('2026-10-07T15:00:00Z');
const item = (id: string, stream: string | undefined, over: Record<string, unknown> = {}): LedgerItem => ({ id, stream, text: `text of ${id}`, date: '2026-10-07', ts: '2026-10-05T12:00:00Z', ...over }) as LedgerItem;
const groupsOf = (over: Partial<Groups> = {}): Groups => ({
  items: [], deferred: [], inflight: [], queued: [], blocked: [], awaiting: [], paste: [], decidedOn: () => [], rollPointOn: () => null, doneOn: () => [], notesOn: () => [], dates: [], ...over,
});
const opts = (over: Partial<StartOptions> = {}): StartOptions => ({
  day: '2026-10-07', week: { state: 'missing' }, priorities: { state: 'missing' }, conditions: [], standing: [], where: null, now: NOW, ...over,
});

test('previousWorkingDay skips the weekend', () => {
  assert.equal(previousWorkingDay('2026-10-07'), '2026-10-06');
  assert.equal(previousWorkingDay('2026-10-05'), '2026-10-02');
  assert.equal(previousWorkingDay('2026-10-04'), '2026-10-02');
  assert.equal(previousWorkingDay('2026-10-03'), '2026-10-02');
});

test('asks rank by the position of their stream in the priorities, then oldest first', () => {
  const g = groupsOf({ awaiting: [item('a1', 'Gamma'), item('b2', 'Beta', { ts: '2026-10-06T00:00:00Z' }), item('c3', 'Beta'), item('d4', 'Alpha')] });
  const s = buildStart(g, opts({ priorities: { state: 'ok', date: '2026-10-07', items: [{ text: 'one', stream: 'alpha' }, { text: 'two', stream: 'Beta' }] } }));
  assert.deepEqual(s.needs.top.map((n) => n.id), ['d4', 'c3', 'b2', 'a1']);
  assert.deepEqual(s.needs.byStream, { Gamma: 1, Beta: 2, Alpha: 1 });
  assert.equal(s.needs.total, 4);
});

test('stakes come from the decision fields, and an ask with none says so rather than inventing them', () => {
  const g = groupsOf({ awaiting: [item('k1', 'Alpha', { door: 'one-way', by: '2026-10-09', recommend: 'yes, merge' }), item('k2', 'Alpha')] });
  const lines = startLines(buildStart(g, opts()), NOW);
  assert.match(lines.find((l) => l.includes('`k1`')) ?? '', /one-way.*2026-10-09.*yes, merge/);
  assert.match(lines.find((l) => l.includes('`k2`')) ?? '', /no decision fields/);
});

test('yesterday, answers and what is in flight come from the board', () => {
  const g = groupsOf({
    inflight: [item('w1', 'Alpha', { model: 'model-x', ts: '2026-10-07T13:00:00Z' })],
    doneOn: (d) => (d === '2026-10-06' ? [item('y1', 'Alpha', { closedBy: { kind: 'done', date: d } })] : []),
    decidedOn: (d) => (d === '2026-10-07' ? [item('r1', 'Beta', { text: 'merge it?', closedBy: { kind: 'resolved', date: d, text: 'yes, after tests' } })] : []),
  });
  const text = startLines(buildStart(g, opts()), NOW).join('\n');
  assert.match(text, /### Yesterday \(2026-10-06\)\n- Alpha: 1 done, text of y1/);
  assert.match(text, /`r1` \[Beta\] merge it\? → yes, after tests/);
  assert.match(text, /### In flight \(1\)\n- `w1` \[Alpha\] text of w1 · model-x · today/);
});

test('without a vault the notes line says they were not read; with one it counts them', () => {
  assert.match(startLines(buildStart(groupsOf(), opts({ where: null })), NOW).join('\n'), /Notes not read: vault_root is not set/);
  const home = { epics: [{}], links: [{ group: 'docs', items: [{ meta: 'CONTEXT' }, { meta: 'Plans · active' }, { meta: 'Plans' }] }, { group: 'runbooks', items: [{}] }] } as unknown as StreamHome;
  assert.deepEqual(homeCounts(home), { context: true, decisions: false, plans: 2, research: 0, reviews: 0, runbooks: 1, epics: 1, prs: 0 });
  assert.match(startLines(buildStart(groupsOf(), opts({ where: { Alpha: homeCounts(home) } })), NOW).join('\n'), /- Alpha: CONTEXT · 1 epic · 2 plans · 1 runbooks/);
});

test('the text never passes the line cap, and a hidden row says where the rest is', () => {
  const many = (p: string, n: number, over: Record<string, unknown> = {}): LedgerItem[] => Array.from({ length: n }, (_, i) => item(`${p}${i}`, `S${i % 4}`, over));
  const g = groupsOf({ awaiting: many('a', 40), inflight: many('f', 40, { model: 'm' }), blocked: many('b', 30), decidedOn: () => many('r', 30, { closedBy: { kind: 'resolved', date: '2026-10-07', text: 'ok' } }) });
  const lines = startLines(buildStart(g, opts({ conditions: Array.from({ length: 30 }, (_, i) => `condition ${i}`) })), NOW);
  assert.ok(lines.length <= START_MAX_LINES, `${lines.length} lines`);
  assert.ok(lines.some((l) => /^… \+\d+ more: journal\.ts status/.test(l)));
  assert.equal(lines.filter((l) => l.startsWith('- `a')).length, 5, 'needs shows its top five');
});

test('--stream narrows every block to one stream, matched without regard to case', () => {
  const g = groupsOf({ awaiting: [item('a1', 'Alpha'), item('b1', 'Beta')], inflight: [item('f1', 'Alpha'), item('f2', 'Beta')] });
  const text = startLines(buildStart(g, opts()), NOW, { stream: 'alpha' }).join('\n');
  assert.match(text, /^## Start here: alpha/);
  assert.ok(text.includes('`a1`') && text.includes('`f1`'));
  assert.ok(!text.includes('`b1`') && !text.includes('`f2`'));
});
