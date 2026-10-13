// Run: node --test scripts/retro-due-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TYPES } from './event-types/index.ts';
import * as due from './event-types/retro-due.ts';
import type { RetroDueState, RetroIo } from './event-types/retro-due.ts';
import type { LedgerRow } from './lib/ledger-core.ts';
import type { WatchEvent } from './lib/types.ts';

const T0 = Date.parse('2026-10-13T08:00:00Z');
const MIN = 60;
const HOUR = 3600;

/** An in-memory ledger and a clock: `run(n)` moves n seconds a minute at a time, checking and collecting events like the loop does. */
function rig() {
  let now = T0;
  let n = 0;
  let version = 0;
  const rows: LedgerRow[] = [];
  const events: WatchEvent[] = [];
  let state: RetroDueState | null = null;
  const io: RetroIo = { ledgerSig: () => String(version), readRows: () => rows };
  const append = (row: Record<string, unknown>): LedgerRow => { const r = { id: `r${String(++n).padStart(3, '0')}`, ts: new Date(now).toISOString(), ...row } as LedgerRow; rows.push(r); version++; return r; };
  const r = {
    events,
    retro: (item = 'w001') => append({ kind: 'agent-retro', retros: item, lessons: [{ source: 'code', text: 'x' }], text: 'retro: 1 lesson (code 1)' }),
    review: (id: string) => append({ kind: 'retro-reviewed', reviews: id, text: 'reviewed' }),
    run: (seconds: number) => { for (let s = 0; s < seconds; s += MIN) { now += MIN * 1000; const next = due.check('dir', { now, prev: state }, io); events.push(...due.diff(state, next)); state = next; } },
  };
  return r;
}

test('the type is registered, local, a renewing singleton', () => {
  assert.equal(BUILTIN_TYPES['retro-due'], due);
  assert.equal(due.network, false);
  assert.equal(due.singleton, true);
  assert.equal(due.renews, true);
});

test('an empty ledger stays silent all day', () => {
  const r = rig();
  r.run(24 * HOUR);
  assert.equal(r.events.length, 0);
});

test('retros wait three hours, then one batch line; silent until a review runs', () => {
  const r = rig();
  r.retro('w001');
  r.run(HOUR);
  r.retro('w002');
  r.run(HOUR + 50 * MIN);
  assert.equal(r.events.length, 0, 'not before three hours since the oldest');
  r.run(15 * MIN);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]?.actionable, true);
  assert.match(r.events[0]?.summary ?? '', /^retro-due: 2 agent retros to review, oldest 3h$/);
  r.run(2 * HOUR);
  assert.equal(r.events.length, 1, 'once per batch');
});

test('no review within three hours repeats the line once', () => {
  const r = rig();
  r.retro();
  r.run(3 * HOUR + 5 * MIN);
  r.run(3 * HOUR + 5 * MIN);
  r.run(10 * HOUR);
  assert.equal(r.events.length, 2);
});

test('ten waiting retros are due at once', () => {
  const r = rig();
  for (let i = 0; i < 10; i++) r.retro(`w${i}`);
  r.run(2 * MIN);
  assert.equal(r.events.length, 1);
});

test('a review clears the batch; the next batch waits three hours from that review', () => {
  const r = rig();
  const a = r.retro();
  r.run(3 * HOUR + 5 * MIN);
  assert.equal(r.events.length, 1);
  r.review(a.id as string);
  r.retro('w002');
  r.run(2 * HOUR);
  assert.equal(r.events.length, 1, 'too soon after the review');
  r.run(HOUR + 5 * MIN);
  assert.equal(r.events.length, 2);
});
