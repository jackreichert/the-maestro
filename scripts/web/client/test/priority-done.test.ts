// Run: node --test scripts/web/client/test/priority-done.test.ts
// Which priorities are done, and the one-shot detection that decides when to celebrate: a real transition only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CELEBRATE_MS, createCelebrator, doneClock, localSeenStore, priorityKey, priorityStatuses } from '../src/priority-done.ts';
import type { PriorityStatus, SeenStore } from '../src/priority-done.ts';
import type { DoneItem, FooterRow, Priority } from '../src/types.ts';

const row = (stream: string, over: Partial<FooterRow> = {}): FooterRow => ({ stream, asks: 0, working: 0, queued: 0, blocked: 0, done: 0, ...over });
const item = (stream: string, closedAt: string): DoneItem => ({ id: `id-${stream}-${closedAt}`, stream, text: 'x', links: { tracker: [], prs: [] }, since: closedAt, closedAt });
const items: Priority[] = [{ text: 'Ship the thing', stream: 'Avonlea' }, { text: 'Review it [Tilling]' }, { text: 'No stream at all' }];
const memory = (): SeenStore & { raw: string | null } => {
  const m = { raw: null as string | null, read: () => m.raw, write: (v: string) => { m.raw = v; } };
  return m;
};
const status = (key: string, done: boolean, doneAt = ''): PriorityStatus => ({ key, stream: key.split('\n')[0] ?? '', done, doneAt });
const A = priorityKey(items[0]!);
const B = priorityKey(items[1]!);

test('a priority is done when its stream finished something today and has nothing open', () => {
  const footer = [row('Avonlea', { done: 2 }), row('Tilling', { done: 1, queued: 1 })];
  const done = [item('Avonlea', '2026-10-19T15:00:00Z'), item('Avonlea', '2026-10-19T19:42:00Z')];
  const [a, b, c] = priorityStatuses(items, footer, done);
  assert.equal(a?.done, true);
  assert.equal(a?.doneAt, '2026-10-19T19:42:00.000Z', 'the latest close is when it finished');
  assert.equal(b?.done, false, 'something is still queued');
  assert.equal(c?.done, false, 'no stream, no ledger to judge it by');
});

test('quiet but never finished is not done, and every kind of open work holds it back', () => {
  for (const open of [{ asks: 1 }, { working: 1 }, { stale: 1 }, { queued: 1 }, { blocked: 1 }]) {
    assert.equal(priorityStatuses([items[0]!], [row('Avonlea', { done: 3, ...open })], [])[0]?.done, false, JSON.stringify(open));
  }
  assert.equal(priorityStatuses([items[0]!], [row('Avonlea')], [])[0]?.done, false, 'nothing done today');
  assert.equal(priorityStatuses([items[0]!], [], [])[0]?.done, false, 'no footer row');
});

test('the first view ever celebrates nothing, even with priorities already done', () => {
  const c = createCelebrator(memory());
  const out = c.observe('2026-10-19', [status(A, true), status(B, false)], 1000);
  assert.equal(out.fresh.size, 0);
  assert.equal(out.announce, '');
});

test('a priority that goes from open to done is celebrated once, with the count before it', () => {
  const store = memory();
  const c = createCelebrator(store);
  c.observe('2026-10-19', [status(A, true), status(B, false)], 1000);
  const out = c.observe('2026-10-19', [status(A, true), status(B, true)], 5000);
  assert.deepEqual([...out.fresh], [B]);
  assert.equal(out.before, 1);
  assert.equal(out.cleared, true, 'that was the last one');
  assert.match(out.announce, /Board cleared/);
  assert.equal(c.observe('2026-10-19', [status(A, true), status(B, true)], 5000 + CELEBRATE_MS).fresh.size, 0, 'and not again');
});

test('a reload does not replay: a new page with the stored memory sees nothing fresh', () => {
  const store = memory();
  const first = createCelebrator(store);
  first.observe('2026-10-19', [status(A, false), status(B, false)], 1000);
  assert.equal(first.observe('2026-10-19', [status(A, true), status(B, false)], 2000).fresh.size, 1);
  const reloaded = createCelebrator(store);
  const out = reloaded.observe('2026-10-19', [status(A, true), status(B, false)], 3000);
  assert.equal(out.fresh.size, 0);
  assert.equal(out.announce, '');
});

test('a live redraw inside the celebration window replays it so it is not cut short, and one after does not', () => {
  const c = createCelebrator(memory());
  c.observe('2026-10-19', [status(A, false)], 0);
  assert.equal(c.observe('2026-10-19', [status(A, true)], 100).fresh.size, 1);
  assert.equal(c.observe('2026-10-19', [status(A, true)], 600).fresh.size, 1);
  assert.equal(c.observe('2026-10-19', [status(A, true)], 100 + CELEBRATE_MS).fresh.size, 0);
});

test('a priority added already done is not a transition, and neither is one that was removed and left', () => {
  const c = createCelebrator(memory());
  c.observe('2026-10-19', [status(A, false)], 0);
  assert.equal(c.observe('2026-10-19', [status(A, false), status(B, true)], 100).fresh.size, 0, 'B was never listed before');
  assert.equal(c.observe('2026-10-19', [status(B, true)], 200).cleared, false, 'removing A is not finishing anything');
});

test('a view on a new day counts what finished since the last view; the board only clears when all are done', () => {
  const store = memory();
  const c = createCelebrator(store);
  c.observe('2026-10-18', [status(A, false)], 0);
  const out = c.observe('2026-10-19', [status(A, true), status(B, false)], 100);
  assert.deepEqual([...out.fresh], [A]);
  assert.equal(out.cleared, false);
  assert.match(out.announce, /1 of 2 priorities done/);
});

test('an unreadable store is a first view', () => {
  const c = createCelebrator({ read: () => '{not json', write: () => {} });
  assert.equal(c.observe('2026-10-19', [status(A, true)], 0).fresh.size, 0);
});

test('the page store survives storage that throws, remembering nothing', () => {
  const g = globalThis as Record<string, unknown>;
  const before = Object.getOwnPropertyDescriptor(g, 'localStorage');
  Object.defineProperty(g, 'localStorage', { configurable: true, value: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } } });
  try {
    const store = localSeenStore();
    assert.equal(store.read(), null);
    assert.doesNotThrow(() => store.write('x'));
  } finally {
    if (before) Object.defineProperty(g, 'localStorage', before); else delete g.localStorage;
  }
});

test('doneClock reads "3:42 pm ET" in the page zone, in either half of the year', () => {
  assert.equal(doneClock('2026-10-19T19:42:00Z', 'America/New_York'), '3:42 pm ET');
  assert.equal(doneClock('2026-01-19T20:42:00Z', 'America/New_York'), '3:42 pm ET');
  assert.equal(doneClock('nonsense', 'America/New_York'), '');
});
