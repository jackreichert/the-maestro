// Run: node --test scripts/lib/journal/parent.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { orphanedParent, parentPromptLine, parentRefusal } from './parent.ts';

const DAY = '2026-10-06';
const row = (id: string, o: Partial<LedgerRow> = {}): LedgerRow => ({ id, kind: 'wip', ts: `${DAY}T09:00:00Z`, date: DAY, text: id, ...o });
const items = (rows: LedgerRow[]) => fold(rows, null).items;
const done = (id: string, closes: string): LedgerRow => ({ id, kind: 'done', ts: `${DAY}T10:00:00Z`, date: DAY, closes, text: closes });

test('orphanedParent offers the parent only when the closed child was its last open one (MAESTRO-319)', () => {
    const rows = [row('p1'), row('c1', { parent: 'p1' }), row('c2', { parent: 'p1' })];
    const one = items([...rows, done('d1', 'c1')]);
    assert.equal(orphanedParent(one, one.find((i) => i.id === 'c1')!), null, 'c2 is still open');
    const both = items([...rows, done('d1', 'c1'), done('d2', 'c2')]);
    assert.equal(orphanedParent(both, both.find((i) => i.id === 'c2')!)?.id, 'p1');
});

test('orphanedParent is silent for a row with no parent, a closed parent and an unknown parent', () => {
    const none = items([row('a'), done('d', 'a')]);
    assert.equal(orphanedParent(none, none[0]), null);
    const closedParent = items([row('p1'), row('c1', { parent: 'p1' }), done('d0', 'p1'), done('d1', 'c1')]);
    assert.equal(orphanedParent(closedParent, closedParent.find((i) => i.id === 'c1')!), null);
    const unknown = items([row('c1', { parent: 'gone' }), done('d1', 'c1')]);
    assert.equal(orphanedParent(unknown, unknown[0]), null);
});

test('parentRefusal accepts an open item and refuses an unknown or closed one', () => {
    const all = items([row('p1'), row('p2'), done('d', 'p2')]);
    assert.equal(parentRefusal(all, 'p1'), null);
    assert.match(parentRefusal(all, 'nope') ?? '', /names no item: nope/);
    assert.match(parentRefusal(all, 'p2') ?? '', /already done/);
});

test('the prompt line names the parent id and the two ways to settle it', () => {
    const [p] = items([row('p1', { text: 'the epic' })]);
    assert.match(parentPromptLine(p), /parent p1 has no other open child.*done p1.*drop p1.*the epic/);
});
