// Run: node --test scripts/lib/journal/settle.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, isOpen } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import type { CloseContext } from './close.ts';
import { planSettle, settleItems } from './settle.ts';

const DAY = '2026-10-06';
const seed = (): LedgerRow[] => [
    { id: 'aaa1', kind: 'wip', ts: `${DAY}T09:00:00Z`, date: DAY, text: 'verify widget' },
    { id: 'bbb2', kind: 'wip', ts: `${DAY}T09:01:00Z`, date: DAY, text: 'build gadget' },
    { id: 'ccc3', kind: 'done', ts: `${DAY}T09:02:00Z`, date: DAY, text: 'old', closes: 'bbb2' },
    { id: 'ddd4', kind: 'learned', ts: `${DAY}T09:03:00Z`, date: DAY, text: 'a fact' },
];

function ctxFor(): { ctx: CloseContext; rows: LedgerRow[] } {
    const rows = seed();
    let n = 0;
    const ctx: CloseContext = {
        readLedger: () => rows,
        append: <E>(entry: E): E => { rows.push(entry as LedgerRow); return entry; },
        newId: () => `n${++n}`,
        fold: (entries) => fold(entries, null),
        today: () => DAY,
        now: () => `${DAY}T10:00:00Z`,
    };
    return { ctx, rows };
}

test('planSettle sorts ids into open, already closed and unknown, by exact id only', () => {
    const { ctx } = ctxFor();
    const plan = planSettle(ctx, ['aaa1', 'bbb2', 'zzzz', 'aaa1', 'widget']);
    assert.deepEqual(plan.open.map((i) => i.id), ['aaa1']);
    assert.deepEqual(plan.notOpen.map((i) => i.id), ['bbb2']);
    assert.deepEqual(plan.unknown, ['zzzz', 'widget'], 'text never matches, so a typo cannot close another item');
});

test('settleItems closes each open item with a resolved row citing the note, and the fold shows it closed', () => {
    const { ctx, rows } = ctxFor();
    const out = settleItems(ctx, 'note9', planSettle(ctx, ['aaa1']));
    assert.deepEqual(out.closed.map((i) => i.id), ['aaa1']);
    const row = rows[rows.length - 1];
    assert.deepEqual([row.kind, row.closes, row.text], ['resolved', 'aaa1', 'settled by note note9']);
    assert.equal(isOpen(ctx.fold(rows).items.find((i) => i.id === 'aaa1') as never), false);
});

test('settling twice writes nothing the second time: a closed item and a learned row are not open, so no row is written for them', () => {
    const { ctx, rows } = ctxFor();
    settleItems(ctx, 'note9', planSettle(ctx, ['aaa1']));
    const before = rows.length;
    const again = planSettle(ctx, ['aaa1', 'ddd4']);
    assert.deepEqual(again.open, []);
    assert.deepEqual(again.notOpen.map((i) => i.id), ['aaa1', 'ddd4']);
    assert.deepEqual(settleItems(ctx, 'note9', again), { closed: [], refused: [], parents: [] });
    assert.equal(rows.length, before);
});
