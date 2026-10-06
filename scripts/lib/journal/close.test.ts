// Run: node --test scripts/lib/journal/close.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { closeItem, matchTarget } from './close.ts';
import type { CloseContext } from './close.ts';

const DAY = '2026-10-06';
const seed = (): LedgerRow[] => [
    { id: 'aaa1', kind: 'wip', ts: `${DAY}T09:00:00Z`, date: DAY, text: 'build widget', repo: 'r1', ticket: 'T-1' },
    { id: 'bbb2', kind: 'wip', ts: `${DAY}T09:01:00Z`, date: DAY, text: 'build gadget' },
    { id: 'ccc3', kind: 'question', ts: `${DAY}T09:02:00Z`, date: DAY, text: 'which color?' },
];

/** A context over an in-memory ledger; `rows` is what was appended. */
function ctxFor(rows: LedgerRow[] = seed()): { ctx: CloseContext; rows: LedgerRow[] } {
    const ctx: CloseContext = {
        readLedger: () => rows,
        append: <E>(entry: E): E => { rows.push(entry as LedgerRow); return entry; },
        newId: () => 'new1',
        fold: (entries) => fold(entries, null),
        today: () => DAY,
        now: () => `${DAY}T10:00:00Z`,
    };
    return { ctx, rows };
}

test('closeItem appends one closing row that carries the target repo, ticket and text', () => {
    const { ctx, rows } = ctxFor();
    const result = closeItem(ctx, { kind: 'done', needle: 'aaa1' });
    assert.equal(result.kind, 'closed');
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[3], { id: 'new1', ts: `${DAY}T10:00:00Z`, date: DAY, kind: 'done', closes: 'aaa1', text: 'build widget', repo: 'r1', ticket: 'T-1' });
});

test('closeItem uses the note as the row text and an explicit ticket over the item ticket', () => {
    const { ctx, rows } = ctxFor();
    const result = closeItem(ctx, { kind: 'resolved', needle: 'ccc3', note: 'blue', ticket: 'T-9', extras: () => ({ model: 'm', used: ['x:y'] }) });
    assert.equal(result.kind === 'closed' && result.note, 'blue');
    assert.equal(rows[3].text, 'blue');
    assert.equal(rows[3].ticket, 'T-9');
    assert.equal(rows[3].model, 'm');
});

test('closeItem matches a unique open item by text, case-insensitively', () => {
    const { ctx, rows } = ctxFor();
    const result = closeItem(ctx, { kind: 'done', needle: 'WIDGET' });
    assert.equal(result.kind === 'closed' && result.target.id, 'aaa1');
    assert.equal(rows[3].closes, 'aaa1');
});

test('an unknown id returns not-found and writes nothing, without running the extras', () => {
    const { ctx, rows } = ctxFor();
    let extrasRan = false;
    const result = closeItem(ctx, { kind: 'done', needle: 'zzzz', extras: () => { extrasRan = true; return {}; } });
    assert.deepEqual(result, { kind: 'not-found' });
    assert.equal(rows.length, 3);
    assert.equal(extrasRan, false);
    assert.deepEqual(closeItem(ctx, { kind: 'done', needle: undefined }), { kind: 'not-found' });
});

test('text matching two open items returns them and writes nothing', () => {
    const { ctx, rows } = ctxFor();
    const result = closeItem(ctx, { kind: 'done', needle: 'build' });
    assert.equal(result.kind, 'ambiguous');
    assert.deepEqual(result.kind === 'ambiguous' && result.matches.map((m) => m.id), ['aaa1', 'bbb2']);
    assert.equal(rows.length, 3);
});

test('a closed item is closed again by default (the CLI behaviour) and skipped with skipIfClosed', () => {
    const { ctx, rows } = ctxFor();
    assert.equal(closeItem(ctx, { kind: 'done', needle: 'aaa1' }).kind, 'closed');
    const skipped = closeItem(ctx, { kind: 'done', needle: 'aaa1', skipIfClosed: true });
    assert.equal(skipped.kind, 'already-closed');
    assert.equal(skipped.kind === 'already-closed' && skipped.target.id, 'aaa1');
    assert.equal(rows.length, 4, 'the skipped call wrote nothing');
    assert.equal(closeItem(ctx, { kind: 'done', needle: 'aaa1' }).kind, 'closed');
    assert.equal(rows.length, 5, 'without skipIfClosed a second closing row is appended');
});

test('skipIfClosed still closes an open item', () => {
    const { ctx, rows } = ctxFor();
    assert.equal(closeItem(ctx, { kind: 'resolved', needle: 'ccc3', skipIfClosed: true }).kind, 'closed');
    assert.equal(rows[3].closes, 'ccc3');
});

test('an extras thunk that throws stops the close before anything is written', () => {
    const { ctx, rows } = ctxFor();
    assert.throws(() => closeItem(ctx, { kind: 'done', needle: 'aaa1', extras: () => { throw new Error('bad flag'); } }), /bad flag/);
    assert.equal(rows.length, 3);
});

test('matchTarget prefers an exact id over text and ignores closed items for text matches', () => {
    const items = fold([...seed(), { id: 'ddd4', kind: 'done', ts: `${DAY}T10:00:00Z`, date: DAY, text: 'x', closes: 'bbb2' }], null).items;
    assert.equal(matchTarget(items, 'bbb2').kind, 'found');
    assert.deepEqual(matchTarget(items, 'gadget'), { kind: 'not-found' });
});
