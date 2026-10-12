// Run: node --test scripts/lib/journal/status-json.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LedgerRow } from '../ledger-core.ts';
import { parseArgs } from './args.ts';
import { openStore } from './store.ts';
import { boardContextFor } from './board-context.ts';
import { footerRows, groups } from './board.ts';
import { statusJson } from './status-json.ts';

const DAY = '2026-10-06';
const SESSION = { available: false, unavailable: 'test' } as const;

/** A real store on a temp ledger root, seeded with rows, and the board context built from it. */
function boardOver(rows: LedgerRow[]) {
    const store = openStore({ vault: mkdtempSync(join(tmpdir(), 'statusjson-')), project: 'p', dryRun: false });
    rows.forEach((r) => store.append(r));
    return { store, ctx: boardContextFor(store, { has: parseArgs(['status']).has, today: () => DAY, dryRun: false }) };
}

const rows: LedgerRow[] = [
    { id: 'aaa1', kind: 'wip', ts: `${DAY}T09:00:00Z`, date: DAY, text: 'running', stream: 'alpha' },
    { id: 'bbb2', kind: 'question', ts: `${DAY}T09:01:00Z`, date: DAY, text: 'which?' },
    { id: 'ccc3', kind: 'wip', ts: `${DAY}T09:02:00Z`, date: DAY, text: 'finished' },
    { id: 'ddd4', kind: 'done', ts: `${DAY}T10:00:00Z`, date: DAY, text: 'finished', closes: 'ccc3' },
];

test('statusJson is the board for the day, with the footer rows and the session it was given', () => {
    const { ctx } = boardOver(rows);
    const g = groups(ctx);
    const json = statusJson(g, DAY, SESSION);
    assert.equal(json.date, DAY);
    assert.deepEqual(json.inflight.map((i) => i.id), ['aaa1']);
    assert.deepEqual(json.awaiting.map((i) => i.id), ['bbb2']);
    assert.deepEqual(json.done.map((i) => i.id), ['ccc3']);
    assert.deepEqual(json.footer.ledger, footerRows(g, json.done));
    assert.deepEqual(json.footer.session, SESSION);
    assert.deepEqual(Object.keys(json), ['date', 'inflight', 'queued', 'blocked', 'awaiting', 'paste', 'done', 'footer']);
});

test('statusJson counts the full day as done today even after a roll, and takes an explicit done list', () => {
    const { ctx } = boardOver([...rows, { id: 'eee5', kind: 'rolled', ts: `${DAY}T11:00:00Z`, date: DAY, text: 'rolled' }]);
    const g = groups(ctx);
    const json = statusJson(g, DAY, SESSION);
    assert.deepEqual(json.done.map((i) => i.id), ['ccc3']);
    assert.equal(json.footer.ledger.find((r) => r.done === 1)?.sinceRoll, 0);
    assert.deepEqual(statusJson(g, DAY, SESSION, g.doneOn(DAY)).done.map((i) => i.id), ['ccc3']);
});

test('boardContextFor reads the registry through the store, so a stream alias maps to its canonical name', () => {
    const { store, ctx } = boardOver([]);
    assert.equal(ctx.mapStream('alpha'), 'alpha');
    store.saveRegistry({ hasStreams: true, streams: { alpha: { aliases: ['a'], status: 'active' } }, models: undefined });
    assert.equal(ctx.mapStream('a'), 'alpha');
    assert.equal(ctx.dir, store.dir);
    assert.equal(ctx.today(), DAY);
});

test('statusJson lists stale in-flight items apart from the live ones, using the configured days (MAESTRO-313)', () => {
    const OLD = '2026-10-01';
    const { ctx } = boardOver([
        { id: 'old1', kind: 'wip', ts: `${OLD}T09:00:00Z`, date: OLD, text: 'forgotten' },
        { id: 'old2', kind: 'wip', ts: `${OLD}T09:00:00Z`, date: OLD, text: 'leased and old' },
        { id: 'new1', kind: 'wip', ts: `${DAY}T09:00:00Z`, date: DAY, text: 'fresh' },
    ]);
    const g = groups(ctx);
    const leases = { held: [{ item: 'old2', holder: 'w1', until: `${DAY}T23:00:00Z` }] } as never;
    assert.equal(statusJson(g, DAY, SESSION).stale, undefined, 'without leases nothing is claimed stale');
    const json = statusJson(g, DAY, SESSION, undefined, undefined, leases, 3);
    assert.deepEqual(json.stale?.map((i) => i.id), ['old1']);
    assert.deepEqual(json.inflight.map((i) => i.id), ['old2', 'new1'], 'the stale row is out of the in-flight list');
    assert.equal(json.footer.ledger[0]?.stale, 1);
    assert.equal(json.footer.ledger[0]?.inflight, 2, 'and out of the in-flight count');
    assert.deepEqual(statusJson(g, DAY, SESSION, undefined, undefined, leases, 30).stale, [], 'a longer limit makes the same row live');
    assert.equal(statusJson(g, DAY, SESSION, undefined, undefined, leases, 30).footer.ledger[0]?.stale, undefined);
});
