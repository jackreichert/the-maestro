// Run: node --test scripts/ledger-core.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, isOpen, canonicalOf, mapStreamWith, parseLedger } from './lib/ledger-core.ts';

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

test('parseLedger skips blank lines, drops malformed ones, and numbers them among the non-blank lines', () => {
    const seen: number[] = [];
    const rows = parseLedger('{"id":"a"}\n\n{oops\n{"id":"b","text":"x"}\n', (n) => seen.push(n));
    assert.deepEqual(rows.map((r) => r.id), ['a', 'b']);
    assert.equal(rows[1]?.text, 'x');
    assert.deepEqual(seen, [2]);
    assert.deepEqual(parseLedger(''), []);
});
