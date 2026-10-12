// Run: node --test scripts/lib/journal/query.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold } from '../ledger-core.ts';
import type { LedgerItem, LedgerRow } from '../ledger-core.ts';
import { filterProblem, queryItems, QUERY_MAX_LIMIT, statusOf } from './query.ts';

const rows: LedgerRow[] = [
    { id: 'aaaa', kind: 'wip', date: '2026-10-09', ts: '2026-10-09T10:00:00Z', stream: 'Alpha', repo: 'r1', text: 'in flight job', model: 'Opus' },
    { id: 'bbbb', kind: 'wip', date: '2026-10-09', ts: '2026-10-09T11:00:00Z', stream: 'Alpha', queued: true, text: 'queued job', model: 'Sonnet' },
    { id: 'cccc', kind: 'wip', date: '2026-10-08', ts: '2026-10-08T09:00:00Z', stream: 'Beta', text: 'finished job', model: 'Sonnet' },
    { id: 'dddd', kind: 'done', date: '2026-10-10', ts: '2026-10-10T09:00:00Z', closes: 'cccc', text: 'finished job' },
    { id: 'eeee', kind: 'blocked', date: '2026-10-07', ts: '2026-10-07T09:00:00Z', stream: 'Beta', text: 'waiting' },
];
const items = (): LedgerItem[] => fold(rows, null).items as LedgerItem[];
const ids = (f: Parameters<typeof queryItems>[1]): (string | undefined)[] => queryItems(items(), f).rows.map((r) => r.id);

test('statusOf names the state of an item', () => {
    const by = Object.fromEntries(items().map((i) => [i.id, statusOf(i)]));
    assert.equal(by.aaaa, 'inflight');
    assert.equal(by.bbbb, 'queued');
    assert.equal(by.cccc, 'done');
    assert.equal(by.eeee, 'blocked');
});

test('filters by stream, id, status, model and date; the date of a closed item is its closing day', () => {
    assert.deepEqual(ids({ stream: 'Alpha' }).sort(), ['aaaa', 'bbbb']);
    assert.deepEqual(ids({ id: 'eeee' }), ['eeee']);
    assert.deepEqual(ids({ status: 'done' }), ['cccc']);
    assert.deepEqual(ids({ status: 'open' }).sort(), ['aaaa', 'bbbb', 'eeee']);
    assert.deepEqual(ids({ model: 'sonnet' }).sort(), ['bbbb', 'cccc']);
    assert.deepEqual(ids({ date: '2026-10-10' }), ['cccc']);
    assert.deepEqual(ids({ since: '2026-10-09', until: '2026-10-09' }).sort(), ['aaaa', 'bbbb']);
    assert.deepEqual(ids({ stream: 'Beta', status: 'blocked' }), ['eeee']);
});

test('the cap holds: the limit trims the rows, total still counts every match, and the limit never exceeds the maximum', () => {
    const r = queryItems(items(), { limit: 2 });
    assert.equal(r.shown, 2);
    assert.ok(r.total > 2);
    const many: LedgerItem[] = Array.from({ length: 300 }, (_, i) => ({ id: `x${i}`, kind: 'wip', text: 't', ts: String(i).padStart(4, '0') }) as LedgerItem);
    assert.equal(queryItems(many, { limit: 5000 }).shown, QUERY_MAX_LIMIT);
    assert.equal(queryItems(many, {}).shown, 50);
});

test('filterProblem refuses a malformed status, day or limit', () => {
    assert.match(filterProblem({ status: 'nope' as never }, null) ?? '', /--status/);
    assert.match(filterProblem({ date: '10/10' }, null) ?? '', /--date/);
    assert.match(filterProblem({}, '0') ?? '', /--limit/);
    assert.match(filterProblem({}, '201') ?? '', /--limit/);
    assert.equal(filterProblem({ status: 'done', since: '2026-10-01' }, '10'), null);
});
