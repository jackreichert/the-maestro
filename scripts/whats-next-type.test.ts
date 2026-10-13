// Run: node --test scripts/whats-next-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, diff, STALE_MS, validate } from './event-types/whats-next.ts';
import type { NextIo, WhatsNextState } from './event-types/whats-next.ts';

const T0 = Date.parse('2026-10-13T12:00:00Z');
const HOUR = 3600_000;

/** A fake ranking: the top item and the snapshot time can be changed between ticks. */
function world(top: string | null, trackerAt: string | null) {
  const w = { top, trackerAt };
  const io: NextIo = { rank: () => ({ top: w.top ? { id: w.top, title: `title of ${w.top}` } : null, trackerAt: w.trackerAt }) };
  let prev: WhatsNextState | null = null;
  const tick = (now: number) => { const next = check('/s', { now, prev }, io); const events = diff(prev, next); prev = next; return events; };
  return { w, tick };
}

test('the first check only records the top item; a later change of top is one informational line', () => {
  const { w, tick } = world('orchard-1', null);
  assert.deepEqual(tick(T0), []);
  assert.deepEqual(tick(T0 + 300_000), []);
  w.top = 'orchard-2';
  assert.deepEqual(tick(T0 + 600_000), [{ summary: 'whats-next: top of the queue is now orchard-2 (title of orchard-2)', actionable: false }]);
  assert.deepEqual(tick(T0 + 900_000), []);
  w.top = null;
  assert.deepEqual(tick(T0 + 1_200_000), [{ summary: 'whats-next: nothing is ready now (journal.ts next --all says why)', actionable: false }]);
});

test('a snapshot older than 6 hours is one actionable line per snapshot; a fresh import resets it; no snapshot is silence', () => {
  const fetched = new Date(T0).toISOString();
  const { w, tick } = world('orchard-1', fetched);
  assert.deepEqual(tick(T0 + STALE_MS), []);
  assert.deepEqual(tick(T0 + STALE_MS + HOUR), [{ summary: 'whats-next: the tracker snapshot is 7h old; refresh it (playbooks/tracker-snapshot.md)', actionable: true }]);
  assert.deepEqual(tick(T0 + STALE_MS + 2 * HOUR), []);
  w.trackerAt = new Date(T0 + 8 * HOUR).toISOString();
  assert.deepEqual(tick(T0 + 8 * HOUR + 60_000), []);
  assert.equal(tick(T0 + 15 * HOUR).length, 1);
  const none = world('orchard-1', null);
  assert.deepEqual(none.tick(T0 + 100 * HOUR), []);
});

test('a stale snapshot is reported on the first check too', () => {
  const { tick } = world('orchard-1', new Date(T0 - 10 * HOUR).toISOString());
  assert.deepEqual(tick(T0).map((e) => e.actionable), [true]);
});

test('the target must be an existing directory', () => {
  assert.throws(() => validate('/no/such/dir/anywhere'), /existing directory/);
});
