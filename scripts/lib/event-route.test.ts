// Run: node --test scripts/lib/event-route.test.ts
// Who owns an inbox event: the window holding a live lease on an open item of the event's repo or stream; and who may take it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerRow } from './ledger-core.ts';
import type { InboxEntry } from './event-inbox.ts';
import { deliverableTo, ownerOf, seenByWindow } from './event-route.ts';
import type { RouteContext } from './event-route.ts';

const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const item = (id: string, extra: Partial<LedgerRow> = {}): LedgerRow => ({ id, kind: 'wip', ts: at(-60), text: id, ...extra });
const lease = (id: string, window: string, min: number, ttl = 60): LedgerRow => ({ kind: 'lease', leases: id, window, ts: at(min), ttl });
const ctx = (rows: LedgerRow[], nowMin = 5, repoStreams: Record<string, string> = {}): RouteContext => ({ rows, registry: null, repoStreams, nowMs: T0 + nowMin * 60_000 });
const event = (repo?: string, extra: Partial<InboxEntry> = {}): InboxEntry => ({
  id: 'aaaaaaaaaaaa', watch: 'prs', type: 'pr-watch', kind: 'thread', at: at(0), actionable: true, fields: repo ? { repo, number: 1 } : {},
  seen: false, handled: false, seenWindows: [], ...extra,
});

test('the window leasing an open item of the event\'s repo owns the event; the repo may be full or short', () => {
  const rows = [item('it1', { repo: 'api' }), lease('it1', 'w1', 0)];
  assert.equal(ownerOf(event('acme/api'), ctx(rows)), 'w1');
  assert.equal(ownerOf(event('acme/web'), ctx(rows)), undefined, 'another repo is nobody\'s');
});

test('the stream config maps a repo to a stream: a lease on any open item of that stream owns the event', () => {
  const rows = [item('it1', { stream: 'Launch' }), lease('it1', 'w2', 0)];
  assert.equal(ownerOf(event('acme/api'), ctx(rows, 5, { api: 'Launch' })), 'w2');
  assert.equal(ownerOf(event('acme/api'), ctx(rows, 5, {})), undefined, 'with no mapping and no item repo there is nothing to match');
  assert.equal(ownerOf(event('acme/api'), ctx(rows, 5, { api: 'Other' })), undefined);
});

test('a lapsed lease, a closed item and an event with no repo have no owner', () => {
  const rows = [item('it1', { repo: 'api' }), lease('it1', 'w1', 0, 10)];
  assert.equal(ownerOf(event('acme/api'), ctx(rows, 9)), 'w1');
  assert.equal(ownerOf(event('acme/api'), ctx(rows, 11)), undefined, 'lapsed at minute 10');
  assert.equal(ownerOf(event('acme/api'), ctx([...rows, { kind: 'done', closes: 'it1', ts: at(2), window: 'w1' }], 5)), undefined, 'done ends the lease');
  assert.equal(ownerOf(event(), ctx([item('it1', { repo: 'api' }), lease('it1', 'w1', 0)])), undefined);
});

test('two windows qualify: the longer lease wins, ties go to the lower window id, so every reader agrees', () => {
  const rows = [item('it1', { repo: 'api' }), item('it2', { repo: 'api' }), lease('it1', 'w1', 0, 30), lease('it2', 'w2', 1, 30)];
  assert.equal(ownerOf(event('acme/api'), ctx(rows)), 'w2');
  const tie = [item('it1', { repo: 'api' }), item('it2', { repo: 'api' }), lease('it1', 'wb', 0), lease('it2', 'wa', 0)];
  assert.equal(ownerOf(event('acme/api'), ctx(tie)), 'wa');
});

test('an owned event is deliverable only to its owner, and only until the owner has seen it', () => {
  const e = event('acme/api');
  assert.equal(deliverableTo(e, 'w1', 'w1'), true);
  assert.equal(deliverableTo(e, 'w2', 'w1'), false);
  assert.equal(deliverableTo({ ...e, seen: true, seenWindows: ['w2'] }, 'w1', 'w1'), true, 'another window\'s mark does not hide it from the owner');
  assert.equal(deliverableTo({ ...e, seen: true, seenWindows: ['w1'] }, 'w1', 'w1'), false);
  assert.equal(deliverableTo({ ...e, handled: true }, 'w1', 'w1'), false);
});

test('an unowned event goes to anyone until some window has seen it; a mark with no window counts for everyone', () => {
  const e = event('acme/api');
  assert.equal(deliverableTo(e, 'w1', undefined), true);
  assert.equal(deliverableTo(e, 'w2', undefined), true);
  assert.equal(deliverableTo({ ...e, seen: true, seenWindows: ['w1'] }, 'w2', undefined), false);
  assert.equal(deliverableTo({ ...e, seen: true, seenAnonymous: true }, 'w2', 'w2'), false);
  assert.equal(seenByWindow({ ...e, seen: true, seenAnonymous: true }, 'w9'), true);
});

test('ownerOf folds the ledger once per context, not once per event', () => {
  const rows = [item('it1', { repo: 'api' }), lease('it1', 'w1', 0)];
  const readsFor = (events: number): number => {
    let reads = 0;
    const c: RouteContext = { ...ctx([]), get rows() { reads += 1; return rows; } };
    for (let i = 0; i < events; i += 1) assert.equal(ownerOf(event('acme/api'), c), 'w1');
    return reads;
  };
  assert.equal(readsFor(200), readsFor(1), 'ledger reads must not grow with the number of events');
});
