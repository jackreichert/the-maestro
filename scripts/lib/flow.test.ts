// Run: node --test scripts/lib/flow.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold } from './ledger-core.ts';
import type { LedgerRow } from './ledger-core.ts';
import { flowReport, formatSpan, ledgerStage, percentile, renderFlow, startOf, waitsOn } from './flow.ts';

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
    const empty = renderFlow(flowReport([], NOW, 14));
    assert.match(empty, /cycle time {2}p50 n\/a/);
    assert.match(empty, /open, oldest first \(age from start\)\n {4}none\n {2}stage dwell/);
    assert.match(empty, /longest dwell {2}none/);
});

const blocked = (id: string, ts: string, extra: Partial<LedgerRow> = {}): LedgerRow => ({ id, ts, date: ts.slice(0, 10), kind: 'blocked', stream: 's', text: `item ${id}`, ...extra });
const ask = (id: string, ts: string, extra: Partial<LedgerRow> = {}): LedgerRow => ({ id, ts, date: ts.slice(0, 10), kind: 'question', stream: 's', text: `item ${id}`, ...extra });

test('stage dwell names the longest current stage and clips in-window time to --days', () => {
    const rows = [
        wip('q', '2026-10-05T12:00:00Z', { queued: true }),
        wip('f', '2026-10-06T12:00:00Z'),
        blocked('b', '2026-09-20T12:00:00Z', { gate: 'date:2099-01-01' }),
        ask('a', '2026-10-07T00:00:00Z'),
        ask('paste', '2026-09-01T00:00:00Z', { paste: 'block.txt', text: 'run the block' }),
        { id: 'decided', ts: '2026-10-01T00:00:00Z', date: '2026-10-01', kind: 'decision', stream: 's', text: 'already decided' },
    ];
    const items = itemsOf(rows);
    assert.equal(ledgerStage(items.find((i) => i.id === 'paste')!), null);
    assert.equal(ledgerStage(items.find((i) => i.id === 'decided')!), null);
    const r = flowReport(items, NOW, 14);
    assert.deepEqual(r.dwell.stages.map((s) => [s.stage, s.items, s.dwellDays, s.longestDays]), [
        ['queued', 1, 2, 2],
        ['in flight', 1, 1, 1],
        ['blocked', 1, 14, 17],
        ['awaiting a person', 1, 0.5, 0.5],
    ]);
    assert.equal(r.dwell.longest, 'blocked');
    assert.equal(r.dwell.longestDays, 17);
    assert.deepEqual(r.dwell.waiting.map((w) => [w.id, w.stage, w.waitsOn]), [
        ['b', 'blocked', 'gate: date:2099-01-01'],
        ['q', 'queued', 'unrecorded'],
        ['f', 'in flight', 'unrecorded'],
        ['a', 'awaiting a person', 'unrecorded'],
    ]);
    const week = flowReport(items, NOW, 7);
    assert.equal(week.dwell.stages.find((s) => s.stage === 'blocked')!.dwellDays, 7);
    assert.equal(week.dwell.longestDays, 17);
});

test('a queue or promote sets the current stage entry, and a missing timestamp is skipped', () => {
    const rows = [
        wip('m', '2026-10-01T12:00:00Z'),
        { id: 'qm', ts: '2026-10-06T12:00:00Z', date: '2026-10-06', kind: 'queue', queues: 'm', text: 'hold' },
        wip('p', '2026-10-01T12:00:00Z', { queued: true }),
        { id: 'pr', ts: '2026-10-06T12:00:00Z', date: '2026-10-06', kind: 'promote', promotes: 'p', text: 'go' },
        blocked('bad', 'not a time'),
        blocked('later', '2026-10-08T12:00:00Z'),
    ];
    const r = flowReport(itemsOf(rows), NOW, 14);
    assert.deepEqual(r.dwell.waiting.map((w) => [w.id, w.stage, w.ageDays]), [['m', 'queued', 1], ['p', 'in flight', 1]]);
    assert.equal(r.dwell.stages.find((s) => s.stage === 'blocked')!.items, 0);
});

test('waitsOn reads a gate, a ticket gate, or a person, and does not invent one', () => {
    assert.equal(waitsOn({ gate: 'ticket:FAKE-1', ticket: 'OTHER-2' }), 'ticket: FAKE-1');
    assert.equal(waitsOn({ gate: '  gh:pr:acme/widgets#2  ' }), 'gate: gh:pr:acme/widgets#2');
    assert.equal(waitsOn({ person: 'Ada' }), 'person: Ada');
    assert.equal(waitsOn({ ticket: 'FAKE-9', text: 'waiting on Ada' }), 'ticket: FAKE-9');
    assert.equal(waitsOn({ kind: 'question', text: 'which way?' }), 'unrecorded');
    assert.equal(waitsOn({ person: '   ' }), 'unrecorded');
});

test('the top 5 longest-waiting items break age ties by id', () => {
    const rows = ['f', 'e', 'd', 'c', 'b', 'a'].map((id, n) => blocked(id, `2026-10-0${n + 1}T12:00:00Z`));
    rows.push(blocked('tie', '2026-10-01T12:00:00Z'));
    const r = flowReport(itemsOf(rows), NOW, 14);
    assert.deepEqual(r.dwell.waiting.map((w) => w.id), ['f', 'tie', 'e', 'd', 'c']);
    assert.equal(r.dwell.longest, 'blocked');
    const same = flowReport(itemsOf([blocked('m', '2026-10-01T12:00:00Z'), ask('a', '2026-10-01T12:00:00Z')]), NOW, 14);
    assert.equal(same.dwell.longest, 'awaiting a person');
    assert.equal(same.dwell.waiting[0].id, 'a');
});

test('renderFlow names the longest dwell and prints unrecorded when the row is silent', () => {
    const text = renderFlow(flowReport(itemsOf([blocked('b', '2026-09-20T12:00:00Z', { gate: 'date:2099-01-01' }), ask('a', '2026-10-07T00:00:00Z')]), NOW, 14));
    assert.match(text, /longest dwell {2}blocked {2}17d/);
    assert.match(text, /awaiting a person\s+12h in window/);
    assert.match(text, /unrecorded {2}item a/);
});
