import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerItem } from '../ledger-core.ts';
import { splitInflight, staleRollLines } from './stale-wip.ts';

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

test('staleRollLines names each stale row oldest first with its age and the three ways to settle it, and says nothing when none is stale', () => {
    const rows = [item('b', '2026-10-09'), item('a', '2026-10-01')];
    const lines = staleRollLines(rows, '2026-10-12', 3);
    assert.match(lines[0], /^Stale in flight: 2 row\(s\) with no lease for 3d or more/);
    assert.match(lines[1], /^ {2}a {2}11d {2}a$/);
    assert.match(lines[2], /^ {2}b {2}3d {2}b$/);
    assert.match(lines[3], /done <id>.*drop <id>.*lease <id>/);
    assert.deepEqual(staleRollLines([], '2026-10-12', 3), []);
});

test('a row opened long ago is not stale when a row touched it within the limit: started, re-tagged or leased (MAESTRO-319)', () => {
    const rows = [item('q1', '2026-10-01'), item('t1', '2026-10-01'), item('k1', '2026-10-01'), item('z1', '2026-10-01')];
    const touched = new Map([['q1', '2026-10-12'], ['t1', '2026-10-11'], ['k1', '2026-10-12']]);
    const { live, stale } = splitInflight(rows, { today: '2026-10-12', leased: new Set(), staleDays: 3, touched });
    assert.deepEqual(stale.map((i) => i.id), ['z1']);
    assert.deepEqual(live.map((i) => i.id), ['q1', 't1', 'k1']);
});

test('a touch older than the limit still leaves the row stale, and a later state move counts as a touch', () => {
    const moved: LedgerItem = { ...item('m1', '2026-10-01'), stateTs: '2026-10-12T08:00:00Z' };
    const rows = [item('a', '2026-10-01'), moved];
    const { stale } = splitInflight(rows, { today: '2026-10-12', leased: new Set(), staleDays: 3, touched: new Map([['a', '2026-10-05']]) });
    assert.deepEqual(stale.map((i) => i.id), ['a']);
});
