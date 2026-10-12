import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerItem } from '../ledger-core.ts';
import { splitInflight } from './stale-wip.ts';

const item = (id: string, date: string): LedgerItem => ({ id, kind: 'wip', date, text: id, closedBy: null, state: undefined });

test('splitInflight puts each row in exactly one list: old and unleased is stale, leased or young is live (MAESTRO-319)', () => {
    const rows = [item('a', '2026-10-01'), item('b', '2026-10-01'), item('c', '2026-10-11'), item('d', '2026-10-09')];
    const { live, stale } = splitInflight(rows, { today: '2026-10-12', leased: new Set(['b']), staleDays: 3 });
    assert.deepEqual(stale.map((i) => i.id), ['a', 'd']);
    assert.deepEqual(live.map((i) => i.id), ['b', 'c']);
    assert.equal(live.length + stale.length, rows.length);
});

test('splitInflight uses the three-day default when no limit is given, and a longer limit makes the row live', () => {
    const rows = [item('a', '2026-10-09')];
    assert.equal(splitInflight(rows, { today: '2026-10-12', leased: new Set() }).stale.length, 1);
    assert.equal(splitInflight(rows, { today: '2026-10-12', leased: new Set(), staleDays: 4 }).stale.length, 0);
});
