// Run: node --test scripts/ledger-core.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, isOpen, isQueued, isInFlight, canonicalOf, mapStreamWith, parseLedger } from './lib/ledger-core.ts';

const reg = { streams: { Launch: { aliases: ['launch-v2'], status: 'active' } } };

test('canonicalOf and mapStreamWith fold case and aliases, and leave unknown names alone', () => {
    assert.equal(canonicalOf(reg, 'LAUNCH'), 'Launch');
    assert.equal(canonicalOf(reg, 'launch-v2'), 'Launch');
    assert.equal(canonicalOf(reg, 'nope'), null);
    assert.equal(mapStreamWith(reg, 'nope'), 'nope');
    assert.equal(mapStreamWith(null, 'launch'), 'launch');
    assert.equal(mapStreamWith(reg, undefined), undefined);
});

test('fold closes, re-homes, stamps and archives without touching the input', () => {
    const rows = [
        { id: 'aaaa', kind: 'wip', text: 'a', stream: 'launch' },
        { id: 'bbbb', kind: 'wip', text: 'b' },
        { id: 'cccc', kind: 'done', closes: 'aaaa', text: 'a' },
        { id: 'dddd', kind: 'tag', tags: 'bbbb', stream: 'launch-v2', text: 's' },
        { id: 'eeee', kind: 'stamp', annotates: 'bbbb', model: 'm1', text: 's' },
        { id: 'ffff', kind: 'archive', stream: 'launch', ids: ['aaaa'], text: 'x' },
    ];
    const copy = JSON.stringify(rows);
    const { items, hidden, archivedStreams } = fold(rows, reg);
    assert.deepEqual(items.map((i) => [i.id, i.stream, i.state, isOpen(i)]), [['aaaa', 'Launch', 'done', false], ['bbbb', 'Launch', 'wip', true]]);
    assert.equal(items[1].model, 'm1');
    assert.deepEqual([...hidden], ['aaaa']);
    assert.deepEqual([...archivedStreams], ['Launch']);
    assert.equal(JSON.stringify(rows), copy);
});

test('parseLedger skips blank lines, drops malformed ones, and numbers them by the real file line', () => {
    const seen: number[] = [];
    const rows = parseLedger('{"id":"a"}\n\n{oops\n{"id":"b","text":"x"}\n', (n) => seen.push(n));
    assert.deepEqual(rows.map((r) => r.id), ['a', 'b']);
    assert.equal(rows[1]?.text, 'x');
    assert.deepEqual(seen, [3]);   // the real file line: the blank line counts
    assert.deepEqual(parseLedger(''), []);
});

test('fold: queue and promote rows move a wip item between queued and in flight; the latest wins', () => {
    const rows = [
        { id: 'aaaa', kind: 'wip', text: 'running', ts: 't1' },
        { id: 'bbbb', kind: 'wip', text: 'born queued', queued: true, ts: 't2' },
        { id: 'cccc', kind: 'queue', queues: 'aaaa', text: 'queue', ts: 't3' },
        { id: 'dddd', kind: 'wip', text: 'queued then started', queued: true, ts: 't4' },
        { id: 'eeee', kind: 'promote', promotes: 'dddd', text: 'promote', ts: 't5' },
        { id: 'ffff', kind: 'wip', text: 'queued, started, queued again', ts: 't6' },
        { id: 'gggg', kind: 'queue', queues: 'ffff', ts: 't7' },
        { id: 'hhhh', kind: 'promote', promotes: 'ffff', ts: 't8' },
        { id: 'iiii', kind: 'queue', queues: 'ffff', ts: 't9' },
    ];
    const copy = JSON.stringify(rows);
    const byId = new Map(fold(rows, null).items.map((i) => [i.id, i]));
    assert.deepEqual([...byId.keys()], ['aaaa', 'bbbb', 'dddd', 'ffff'], 'queue and promote rows are events, not items');
    assert.deepEqual(['aaaa', 'bbbb', 'dddd', 'ffff'].map((id) => [isQueued(byId.get(id)!), isInFlight(byId.get(id)!)]), [[true, false], [true, false], [false, true], [true, false]]);
    assert.equal(byId.get('aaaa')?.stateTs, 't3');
    assert.equal(byId.get('dddd')?.stateTs, 't5');
    assert.equal(byId.get('bbbb')?.stateTs, undefined);
    assert.equal('queued' in byId.get('dddd')!, false, 'a promoted item carries no queued flag');
    assert.equal(JSON.stringify(rows), copy);
});

test('fold: a closed item is neither queued nor in flight', () => {
    const rows = [
        { id: 'aaaa', kind: 'wip', queued: true, text: 'a' },
        { id: 'bbbb', kind: 'done', closes: 'aaaa', text: 'a' },
    ];
    const [item] = fold(rows, null).items;
    assert.equal(isQueued(item), false);
    assert.equal(isInFlight(item), false);
});
