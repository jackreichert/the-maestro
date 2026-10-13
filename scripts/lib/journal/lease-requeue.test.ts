// Run: node --test scripts/lib/journal/lease-requeue.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { lapsedRequeues, liveAgent, windowRequeues } from './lease-requeue.ts';

const at = (min: number): string => new Date(Date.parse('2026-10-13T08:00:00Z') + min * 60_000).toISOString();
const NOW = Date.parse(at(300));
const rows = (...r: Partial<LedgerRow>[]): LedgerRow[] => r.map((x, n) => ({ id: `r${n}`, date: '2026-10-13', text: 'row', ...x }) as LedgerRow);
const items = (rs: LedgerRow[]) => fold(rs, null).items;

test('a lapsed lease with no agent requeues the row; a live lease, a queued row and a never-leased row are left alone', () => {
    const rs = rows(
        { id: 'old1', kind: 'wip', ts: at(0), window: 'wa', leaseTtl: 60, text: 'abandoned' },
        { id: 'new1', kind: 'wip', ts: at(280), window: 'wa', leaseTtl: 60, text: 'working' },
        { id: 'nol1', kind: 'wip', ts: at(0), text: 'never leased' },
        { id: 'que1', kind: 'wip', ts: at(0), window: 'wa', leaseTtl: 60, text: 'queued', queued: true },
    );
    const out = lapsedRequeues(rs, items(rs), NOW);
    assert.deepEqual(out.map((r) => [r.kind, r.queues]), [['queue', 'old1']]);
    assert.match(String(out[0].text), /lease lapsed, no agent running/);
});

test('an agent still running keeps its row in flight, and its return releases it to the lapse rule', () => {
    const base = rows({ id: 'agt1', kind: 'wip', ts: at(0), window: 'wa', leaseTtl: 60, text: 'dispatched' });
    const running = [...base, ...rows({ kind: 'lease', ts: at(200), window: 'wa', leases: 'agt1', ttl: 240, agent: true })];
    assert.equal(liveAgent(running, 'agt1', NOW), true);
    assert.deepEqual(lapsedRequeues(running, items(running), NOW), []);
    const returned = [...running, ...rows({ kind: 'next', ts: at(210), window: 'wa', nexts: 'agt1', agentReturned: true }, { kind: 'lease', ts: at(210), window: 'wa', leases: 'agt1', ttl: 60 })];
    assert.equal(liveAgent(returned, 'agt1', NOW), false);
    assert.equal(lapsedRequeues(returned, items(returned), NOW).length, 1, 'returned, then the short lease the return hook writes runs out: requeued');
});

test('windowRequeues puts the ending window\'s live leases back to queued and releases them, and touches nobody else', () => {
    const rs = rows(
        { id: 'mine', kind: 'wip', ts: at(290), window: 'wa', leaseTtl: 60, text: 'mine' },
        { id: 'oth1', kind: 'wip', ts: at(290), window: 'wb', leaseTtl: 60, text: 'theirs' },
    );
    const out = windowRequeues(rs, items(rs), 'wa', NOW);
    assert.deepEqual(out.map((r) => [r.kind, r.queues ?? r.unleases]), [['queue', 'mine'], ['unlease', 'mine']]);
    assert.ok(out.every((r) => r.window === 'wa'));
    const after = [...rs, ...out.map((r, n) => ({ ...r, id: `x${n}` }))];
    assert.deepEqual(items(after).filter((i) => i.queued).map((i) => i.id), ['mine']);
    assert.deepEqual(windowRequeues(after, items(after), 'wa', NOW), [], 'idempotent');
});
