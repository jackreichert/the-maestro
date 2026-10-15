// Run: node --test scripts/lib/journal/close.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { closeItem, matchTarget, prRef } from './close.ts';
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

test('closeItem refuses a miss row, whatever the closing kind, and appends nothing', () => {
    for (const kind of ['done', 'dropped', 'resolved']) {
        const { ctx, rows } = ctxFor([...seed(), { id: 'mis1', kind: 'miss', ts: `${DAY}T09:03:00Z`, date: DAY, text: 'A fake miss.' }]);
        const result = closeItem(ctx, { kind, needle: 'mis1' });
        assert.equal(result.kind, 'not-closable', kind);
        assert.match(result.kind === 'not-closable' ? result.reason : '', /miss row: it is closed only by a composer pass/);
        assert.equal(rows.length, 4, kind);
    }
});

test('closeItem refuses a learned row, whatever the closing kind, and appends nothing', () => {
    for (const kind of ['done', 'dropped', 'resolved']) {
        const { ctx, rows } = ctxFor([...seed(), { id: 'lrn1', kind: 'learned', ts: `${DAY}T09:03:00Z`, date: DAY, text: 'A fake fact.' }]);
        const result = closeItem(ctx, { kind, needle: 'lrn1' });
        assert.equal(result.kind, 'not-closable', kind);
        assert.match(result.kind === 'not-closable' ? result.reason : '', /closed only by a composer pass/);
        assert.equal(rows.length, 4, kind);
    }
    const { ctx, rows } = ctxFor([...seed(), { id: 'lrn1', kind: 'learned', ts: `${DAY}T09:03:00Z`, date: DAY, text: 'A unique fake fact.' }]);
    assert.equal(closeItem(ctx, { kind: 'done', needle: 'unique fake' }).kind, 'not-found', 'a text match never selects a learned row (it is not an open kind)');
    assert.equal(rows.length, 4);
});

test('closeItem returns the parent when the closed child was its last open one, and not while a sibling is open (MAESTRO-319)', () => {
    const rows: LedgerRow[] = [
        { id: 'par1', kind: 'wip', ts: `${DAY}T09:00:00Z`, date: DAY, text: 'the epic' },
        { id: 'kid1', kind: 'wip', ts: `${DAY}T09:01:00Z`, date: DAY, text: 'first', parent: 'par1' },
        { id: 'kid2', kind: 'wip', ts: `${DAY}T09:02:00Z`, date: DAY, text: 'second', parent: 'par1' },
    ];
    const { ctx } = ctxFor(rows);
    const first = closeItem(ctx, { kind: 'done', needle: 'kid1' });
    assert.equal(first.kind === 'closed' && first.parent, undefined);
    const last = closeItem(ctx, { kind: 'done', needle: 'kid2' });
    assert.equal(last.kind === 'closed' && last.parent?.id, 'par1');
});

test('a guard refuses an open target and nothing is appended; a closed target skips the guard', () => {
    const { ctx, rows } = ctxFor();
    const result = closeItem(ctx, { kind: 'done', needle: 'aaa1', guard: (t) => `no retro for ${t.id}` });
    assert.deepEqual(result.kind === 'not-closable' && result.reason, 'no retro for aaa1');
    assert.equal(rows.length, 3);
    assert.equal(closeItem(ctx, { kind: 'done', needle: 'aaa1' }).kind, 'closed');
    let asked = false;
    assert.equal(closeItem(ctx, { kind: 'done', needle: 'aaa1', guard: () => { asked = true; return 'x'; } }).kind, 'closed');
    assert.equal(asked, false);
});

// ---- follow-up for a resolved ask that names a PR (MAESTRO-309) ----

const askSeed = (text: string): LedgerRow[] => [{ id: 'ask1', kind: 'question', ts: `${DAY}T09:00:00Z`, date: DAY, text, stream: 'S', repo: 'api', ticket: 'T-2' }];
/** Like ctxFor, but every call to newId gives a fresh id, as the real store does. */
function ctxWithIds(rows: LedgerRow[]): CloseContext {
    let n = 0;
    return { ...ctxFor(rows).ctx, newId: () => `id${(n += 1)}` };
}

test('prRef finds owner/repo#N and a bare #NN, and ignores a lone #1, a url fragment and plain words', () => {
    assert.equal(prRef('see org/api#4071 please'), 'org/api#4071');
    assert.equal(prRef('PR #4071 waits'), '#4071');
    assert.equal(prRef('step #1 then step 2'), null);
    assert.equal(prRef('https://x.example/page#123'), null);
    assert.equal(prRef('no reference here'), null);
    assert.equal(prRef(undefined), null);
});

test('closeItem followUp: resolving an ask that names a PR queues a to-do carrying the answer, the PR and the ask', () => {
    const rows = askSeed('Merge order for #4071?');
    const result = closeItem(ctxWithIds(rows), { kind: 'resolved', needle: 'ask1', note: 'merge the staging twin first', followUp: true });
    assert.equal(result.kind, 'closed');
    const queued = rows.find((r) => r.kind === 'wip');
    assert.ok(queued, 'a follow-up row was appended');
    assert.equal(queued.queued, true);
    assert.deepEqual(queued.refs, ['#4071']);
    assert.match(queued.text ?? '', /^Follow up on #4071 \(ask ask1\): merge the staging twin first/);
    assert.deepEqual([queued.stream, queued.repo, queued.ticket], ['S', 'api', 'T-2']);
    assert.equal(result.kind === 'closed' && result.followUp?.id, queued.id);
    const items = fold(rows, null).items;
    assert.equal(items.find((i) => i.id === queued.id)?.queued, true, 'it folds to an open queued item');
});

test('closeItem followUp: the PR may be named in the answer alone', () => {
    const rows = askSeed('What next?');
    closeItem(ctxWithIds(rows), { kind: 'resolved', needle: 'ask1', note: 'rebase org/api#77', followUp: true });
    assert.deepEqual(rows.find((r) => r.kind === 'wip')?.refs, ['org/api#77']);
});

test('closeItem followUp: nothing is queued without a PR, without the option, for a non-ask or a non-resolve', () => {
    const plain = askSeed('Which color?');
    closeItem(ctxWithIds(plain), { kind: 'resolved', needle: 'ask1', note: 'blue', followUp: true });
    assert.equal(plain.some((r) => r.kind === 'wip'), false);
    const off = askSeed('Merge #4071?');
    closeItem(ctxWithIds(off), { kind: 'resolved', needle: 'ask1', note: 'yes' });
    assert.equal(off.some((r) => r.kind === 'wip'), false, 'automatic closers leave followUp off');
    const dropped = askSeed('Merge #4071?');
    closeItem(ctxWithIds(dropped), { kind: 'dropped', needle: 'ask1', note: 'no', followUp: true });
    assert.equal(dropped.some((r) => r.kind === 'wip'), false);
    const wip: LedgerRow[] = [{ id: 'w1', kind: 'wip', ts: `${DAY}T09:00:00Z`, date: DAY, text: 'ship #4071' }];
    closeItem(ctxWithIds(wip), { kind: 'resolved', needle: 'w1', note: 'done', followUp: true });
    assert.equal(wip.filter((r) => r.kind === 'wip').length, 1, 'a wip item is not an ask');
});

test('closeItem followUp: an open follow-up for the same ask is not queued twice', () => {
    const rows = askSeed('Merge #4071?');
    rows.push({ id: 'old', kind: 'wip', queued: true, ts: `${DAY}T09:05:00Z`, date: DAY, text: 'Follow up on #4071 (ask ask1): yes' });
    const result = closeItem(ctxWithIds(rows), { kind: 'resolved', needle: 'ask1', note: 'yes', followUp: true });
    assert.equal(result.kind === 'closed' && result.followUp, undefined);
    assert.equal(rows.filter((r) => r.kind === 'wip').length, 1);
});
