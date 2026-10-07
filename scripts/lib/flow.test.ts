// Run: node --test scripts/lib/flow.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold } from './ledger-core.ts';
import type { LedgerRow } from './ledger-core.ts';
import { flowReport, formatSpan, percentile, renderFlow, startOf } from './flow.ts';

const NOW = new Date('2026-10-07T12:00:00Z');
const wip = (id: string, ts: string, extra: Partial<LedgerRow> = {}): LedgerRow => ({ id, ts, date: ts.slice(0, 10), kind: 'wip', stream: 's', text: `item ${id}`, ...extra });
const done = (id: string, ts: string, closes: string): LedgerRow => ({ id, ts, date: ts.slice(0, 10), kind: 'done', closes, text: 'done' });
const itemsOf = (rows: LedgerRow[]) => fold(rows, null).items;

test('percentile is nearest-rank and null on an empty list', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([5], 85), 5);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
    assert.equal(percentile([10, 1, 3, 2, 4, 5, 6, 7, 8, 9], 85), 9);
});

test('formatSpan picks minutes, hours or days', () => {
    assert.equal(formatSpan(10 / 1440), '10m');
    assert.equal(formatSpan(3 / 24), '3h');
    assert.equal(formatSpan(5), '5d');
});

test('cycle time runs from start to done; throughput counts done items in the window only', () => {
    const rows = [
        wip('a', '2026-10-06T10:00:00Z'), done('da', '2026-10-06T12:00:00Z', 'a'),
        wip('b', '2026-10-01T00:00:00Z'), done('db', '2026-10-05T00:00:00Z', 'b'),
        wip('old', '2026-08-01T00:00:00Z'), done('dold', '2026-08-02T00:00:00Z', 'old'),
        wip('x', '2026-10-03T00:00:00Z'), { id: 'dx', ts: '2026-10-04T00:00:00Z', date: '2026-10-04', kind: 'dropped', closes: 'x', text: 'no' },
    ];
    const r = flowReport(itemsOf(rows), NOW, 14);
    assert.equal(r.done, 2);
    assert.equal(r.dropped, 1);
    assert.equal(r.perWeek, 1);
    assert.equal(r.cycleP50, 0.083);
    assert.equal(r.cycleP85, 4);
});

test('a queued item starts when it is promoted, and open items are listed oldest first', () => {
    const rows = [
        wip('q', '2026-10-01T00:00:00Z', { queued: true }),
        wip('p', '2026-09-20T00:00:00Z', { queued: true }),
        { id: 'pr', ts: '2026-10-05T12:00:00Z', date: '2026-10-05', kind: 'promote', promotes: 'p', text: 'go' },
        wip('f', '2026-10-06T12:00:00Z'),
    ];
    const items = itemsOf(rows);
    assert.equal(startOf(items.find((i) => i.id === 'p')!), '2026-10-05T12:00:00Z');
    assert.equal(startOf(items.find((i) => i.id === 'q')!), '2026-10-01T00:00:00Z');
    const r = flowReport(items, NOW, 14);
    assert.deepEqual(r.open.map((i) => [i.id, i.ageDays, i.queued]), [['q', 6.5, true], ['p', 2, false], ['f', 1, false]]);
    assert.equal(r.wip, 2);
    assert.equal(r.queued, 1);
});

test('items without a usable timestamp are skipped rather than guessed', () => {
    const rows = [wip('n', 'not a time'), wip('ok', '2026-10-07T00:00:00Z'), done('dn', '2026-10-06T00:00:00Z', 'n')];
    const r = flowReport(itemsOf(rows), NOW, 14);
    assert.deepEqual(r.open.map((i) => i.id), ['ok']);
    assert.equal(r.cycleP50, null);
});

test('renderFlow prints the service level line and caps the open list', () => {
    const rows = [wip('a', '2026-10-06T10:00:00Z'), done('da', '2026-10-06T12:00:00Z', 'a'), wip('b', '2026-10-01T00:00:00Z'), wip('c', '2026-10-02T00:00:00Z')];
    const text = renderFlow(flowReport(itemsOf(rows), NOW, 14), 1);
    assert.match(text, /throughput {2}1 done \(0\.5\/week\)/);
    assert.match(text, /cycle time {2}p50 2h, p85 2h/);
    assert.match(text, /\.\.\. 1 more/);
    assert.match(renderFlow(flowReport([], NOW, 14)), /cycle time {2}p50 n\/a/);
});
