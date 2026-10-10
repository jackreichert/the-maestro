// Run: node --test scripts/library-due-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TYPES } from './event-types/index.ts';
import * as due from './event-types/library-due.ts';
import type { DueIo, LibraryDueState } from './event-types/library-due.ts';
import { acquireLease, releaseLease } from './lib/journal/leases.ts';
import type { LedgerRow } from './lib/ledger-core.ts';
import { COMPOSER_ITEM } from './lib/library/composer.ts';
import type { WatchEvent } from './lib/types.ts';

const T0 = Date.parse('2026-10-10T12:00:00Z');
const SEC = 1000;

/** An in-memory ledger and a clock: `step(n)` moves n seconds and runs one check, carrying the state and collecting events like the loop does. */
function rig() {
  let now = T0;
  let n = 0;
  let version = 0;
  const rows: LedgerRow[] = [];
  const events: WatchEvent[] = [];
  let state: LibraryDueState | null = null;
  const io: DueIo = { ledgerSig: () => String(version), readRows: () => rows };
  const append = (row: Record<string, unknown>): LedgerRow => { const r = { id: `r${++n}`, ts: new Date(now).toISOString(), date: new Date(now).toISOString().slice(0, 10), ...row } as LedgerRow; rows.push(r); version++; return r; };
  const lease = { readLedger: () => rows, append: (r: LedgerRow) => { rows.push(r); version++; }, window: 'cmptest0001', now: () => new Date(now).toISOString(), dryRun: false };
  const r = {
    rows, events, at: () => now,
    learned: (repo = 'dev-env') => append({ kind: 'learned', text: `fact ${n}`, repo }),
    curate: (closes: string) => append({ kind: 'curated', closes, text: `curated ${closes}`, rejected: 'not durable' }),
    rolled: () => append({ kind: 'rolled', text: 'archived 0 item(s)' }),
    begin: () => acquireLease(lease, COMPOSER_ITEM, { ttlMinutes: 30, text: 'composer pass' }),
    end: () => releaseLease(lease, COMPOSER_ITEM, false),
    step: (seconds: number) => { now += seconds * SEC; const next = due.check('dir', { now, prev: state }, io); events.push(...(due.diff(state, next) ?? [])); state = next; return next; },
    run: (seconds: number) => { for (let s = 0; s < seconds; s += 60) r.step(60); },
  };
  return r;
}

test('zero pending rows over a simulated day emit nothing', () => {
  const r = rig();
  r.run(24 * 3600);
  assert.equal(r.events.length, 0);
});

test('three rows emit once after ten quiet minutes, with the batch line', () => {
  const r = rig();
  r.run(120);
  r.learned('arya-scraper'); r.learned('arya-scraper'); r.learned('dev-env');
  r.run(9 * 60);
  assert.equal(r.events.length, 0, 'not before ten minutes of quiet');
  r.run(2 * 60);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]?.actionable, true);
  assert.match(r.events[0]?.summary ?? '', /^library-due: 3 learned to compose \(arya-scraper 2, dev-env 1\), oldest \d+m$/);
  r.run(3600);
  assert.equal(r.events.length, 1, 'silent until a pass begins');
});

test('another write inside the quiet window restarts the ten minutes', () => {
  const r = rig();
  r.run(120);
  r.learned();
  r.run(8 * 60);
  r.learned();
  r.run(8 * 60);
  assert.equal(r.events.length, 0);
  r.run(4 * 60);
  assert.equal(r.events.length, 1);
});

test('curated and lease rows never re-emit, and a live lease suppresses', () => {
  const r = rig();
  r.run(120);
  const ids = [r.learned().id as string, r.learned().id as string, r.learned().id as string];
  r.run(11 * 60);
  assert.equal(r.events.length, 1);
  assert.equal(r.begin().ok, true);
  r.run(600);
  r.curate(ids[0] as string);
  r.run(600);
  r.curate(ids[1] as string);
  r.run(600);
  assert.equal(r.events.length, 1, 'the composer pass did not wake itself');
  r.curate(ids[2] as string);
  r.end();
  r.run(2 * 3600);
  assert.equal(r.events.length, 1, 'nothing pending, nothing to say');
});

test('a live lease holds a due batch back until the pass ends', () => {
  const r = rig();
  r.run(120);
  r.begin();
  r.learned();
  r.run(20 * 60);
  assert.equal(r.events.length, 0, 'a pass is running');
  r.end();
  r.run(31 * 60);
  assert.equal(r.events.length, 1, 'quiet and past the floor once the pass ended');
});

test('eight rows emit without waiting for quiet', () => {
  const r = rig();
  r.run(120);
  for (let i = 0; i < 8; i++) { r.learned(); r.step(5); }
  assert.equal(r.events.length, 1);
  assert.match(r.events[0]?.summary ?? '', /8 learned to compose/);
});

test('a rolled row carries a single pending row', () => {
  const r = rig();
  r.run(120);
  r.learned();
  r.run(120);
  assert.equal(r.events.length, 0);
  r.rolled();
  r.step(60);
  assert.equal(r.events.length, 1);
  assert.match(r.events[0]?.summary ?? '', /1 learned to compose/);
});

test('a roll older than the pending row does not count', () => {
  const r = rig();
  r.rolled();
  r.run(120);
  r.learned();
  r.run(5 * 60);
  assert.equal(r.events.length, 0);
});

test('with no pass beginning, the batch is repeated once after two hours', () => {
  const r = rig();
  r.run(120);
  r.learned(); r.learned();
  r.run(11 * 60);
  assert.equal(r.events.length, 1);
  r.run(2 * 3600 - 15 * 60);
  assert.equal(r.events.length, 1, 'not yet two hours since the first');
  r.run(30 * 60);
  assert.equal(r.events.length, 2);
  r.run(6 * 3600);
  assert.equal(r.events.length, 2, 'only once');
});

test('the thirty minute floor holds back a quiet batch right after a pass', () => {
  const r = rig();
  r.run(120);
  r.begin();
  r.end();
  r.learned();
  r.run(11 * 60);
  assert.equal(r.events.length, 0, 'the pass began under thirty minutes ago');
  r.run(25 * 60);
  assert.equal(r.events.length, 1);
});

test('registered as a built-in with a playbook and the declared schedule', async () => {
  const t = BUILTIN_TYPES['library-due'];
  assert.ok(t);
  assert.equal(t.interval, 60);
  assert.equal(t.network, false);
  assert.equal(t.singleton, true);
  assert.equal(t.renews, true);
  assert.equal(t.notifies, undefined);
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(new URL('../playbooks/event-types/library-due.md', import.meta.url)));
});
