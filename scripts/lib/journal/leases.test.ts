// Run: node --test scripts/lib/journal/leases.test.ts
// The lease fold and acquire/release over an in-memory ledger: first row wins, expiry, renewal by activity, steal, close, release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerRow } from '../ledger-core.ts';
import { acquireLease, foldLeases, liveLease, releaseLease, summarizeLeases, type LeaseContext } from './leases.ts';

const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const lease = (window: string, min: number, extra: Partial<LedgerRow> = {}): LedgerRow => ({ kind: 'lease', leases: 'it01', window, ts: at(min), ttl: 30, ...extra });

test('the earliest lease row wins; a later row from another window is ignored while the first is live', () => {
  const held = foldLeases([lease('a', 0), lease('b', 1)]);
  assert.equal(held.get('it01')?.holder, 'a');
  assert.equal(liveLease(held, 'it01', T0 + 29 * 60_000)?.holder, 'a');
});

test('a lease lapses after its ttl and the next window can take it', () => {
  const rows = [lease('a', 0), lease('b', 31)];
  assert.equal(foldLeases(rows).get('it01')?.holder, 'b');
  assert.equal(liveLease(foldLeases([lease('a', 0)]), 'it01', T0 + 31 * 60_000), undefined);
});

test('any row the holder writes renews its leases; another window\'s row does not', () => {
  const rows = [lease('a', 0), { kind: 'note', window: 'a', ts: at(25), id: 'n1' }, { kind: 'note', window: 'b', ts: at(26), id: 'n2' }];
  const l = liveLease(foldLeases(rows), 'it01', T0 + 50 * 60_000);
  assert.equal(l?.holder, 'a', 'renewed at minute 25, so live until minute 55');
  assert.equal(liveLease(foldLeases([lease('a', 0), { kind: 'note', window: 'b', ts: at(10), id: 'n3' }]), 'it01', T0 + 31 * 60_000), undefined);
});

test('activity after a lease lapsed does not bring it back', () => {
  const rows = [lease('a', 0), { kind: 'note', window: 'a', ts: at(40), id: 'n1' }];
  assert.equal(liveLease(foldLeases(rows), 'it01', T0 + 41 * 60_000), undefined);
});

test('steal takes a live lease; an unmarked row does not', () => {
  assert.equal(foldLeases([lease('a', 0), lease('b', 1, { steal: true })]).get('it01')?.holder, 'b');
  assert.equal(foldLeases([lease('a', 0), lease('b', 1, { steal: false })]).get('it01')?.holder, 'a');
});

test('a closing row, or the holder\'s unlease, frees the item; another window\'s unlease needs force', () => {
  assert.equal(foldLeases([lease('a', 0), { kind: 'done', closes: 'it01', window: 'a', ts: at(1), id: 'd1' }]).has('it01'), false);
  assert.equal(foldLeases([lease('a', 0), { kind: 'unlease', unleases: 'it01', window: 'a', ts: at(1) }]).has('it01'), false);
  assert.equal(foldLeases([lease('a', 0), { kind: 'unlease', unleases: 'it01', window: 'b', ts: at(1) }]).get('it01')?.holder, 'a');
  assert.equal(foldLeases([lease('a', 0), { kind: 'unlease', unleases: 'it01', window: 'b', ts: at(1), force: true }]).has('it01'), false);
});

test('rows without a window or a timestamp never hold a lease', () => {
  assert.equal(foldLeases([{ kind: 'lease', leases: 'it01', ts: at(0), ttl: 30 }, { kind: 'lease', leases: 'it01', window: 'a', ttl: 30 }]).size, 0);
});

function memory(window: string, rows: LedgerRow[], nowMin: number): LeaseContext {
  return { readLedger: () => rows, append: (r) => { rows.push({ window, ...r }); }, window, now: () => at(nowMin), dryRun: false };
}

test('acquire writes one row when free, none when already ours with time left, and refuses without writing when another holds it', () => {
  const rows: LedgerRow[] = [];
  const a = acquireLease(memory('a', rows, 0), 'it01', { ttlMinutes: 30 });
  assert.ok(a.ok && a.wrote);
  assert.equal(rows.length, 1);
  const again = acquireLease(memory('a', rows, 5), 'it01', { ttlMinutes: 30 });
  assert.ok(again.ok && !again.wrote);
  const b = acquireLease(memory('b', rows, 6), 'it01', { ttlMinutes: 30 });
  assert.ok(!b.ok && b.lease.holder === 'a');
  assert.equal(rows.length, 1, 'a refusal writes nothing');
  const stolen = acquireLease(memory('b', rows, 7), 'it01', { ttlMinutes: 30, steal: true });
  assert.ok(stolen.ok);
  assert.equal(rows.at(-1)?.from, 'a', 'the steal row says whose lease it took');
});

test('acquire renews its own lease once less than half the ttl remains', () => {
  const rows: LedgerRow[] = [];
  acquireLease(memory('a', rows, 0), 'it01', { ttlMinutes: 30 });
  const r = acquireLease(memory('a', rows, 20), 'it01', { ttlMinutes: 30 });
  assert.ok(r.ok && r.wrote);
});

test('a lease row that lost a race is ignored and the loser is told who won', () => {
  // b appended at the same moment as a but after it, then folded: its own row is the second one.
  const rows: LedgerRow[] = [lease('a', 0)];
  const ctx: LeaseContext = { readLedger: () => rows, append: (r) => { rows.push({ window: 'b', ...r }); }, window: 'b', now: () => at(0), dryRun: false };
  // Simulate the stale pre-check: b read the ledger before a's row landed.
  let first = true;
  const stale = { ...ctx, readLedger: () => (first ? ((first = false), []) : rows) };
  const got = acquireLease(stale, 'it01', { ttlMinutes: 30 });
  assert.ok(!got.ok && got.lease.holder === 'a');
});

test('release frees the holder\'s own lease, refuses another window without force, and reports no lease', () => {
  const rows: LedgerRow[] = [];
  acquireLease(memory('a', rows, 0), 'it01', { ttlMinutes: 30 });
  assert.ok('heldBy' in releaseLease(memory('b', rows, 1), 'it01', false));
  assert.ok('freed' in releaseLease(memory('b', rows, 1), 'it01', true));
  assert.ok('none' in releaseLease(memory('a', rows, 2), 'it01', false));
});

test('the summary counts live leases on open items by holder', () => {
  const held = foldLeases([lease('a', 0), lease('b', 0, { leases: 'it02' }), lease('a', 0, { leases: 'it03' })]);
  const s = summarizeLeases(held, 'a', T0 + 60_000, (id) => id !== 'it03');
  assert.deepEqual([s.mine, s.other, s.held.length], [1, 1, 2]);
});

test('a new in-flight wip row with leaseTtl leases its own id; a queued one, or one without leaseTtl, does not', () => {
  const wip = (extra: Partial<LedgerRow>): LedgerRow => ({ kind: 'wip', id: 'w1', window: 'a', ts: at(0), ...extra });
  assert.equal(foldLeases([wip({ leaseTtl: 30 })]).get('w1')?.holder, 'a');
  assert.equal(foldLeases([wip({ leaseTtl: 30, queued: true })]).size, 0);
  assert.equal(foldLeases([wip({})]).size, 0);
});
