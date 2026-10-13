// Run: node --test scripts/lib/journal/age-out.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, isOpen } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import type { CloseContext } from './close.ts';
import { applyProposals, namedBranch, proposalLines, proposeCloses } from './age-out.ts';
import type { AgeOutLookups } from './age-out.ts';
import { applyClosing, chosenClosing, planClosing, planRefusal, CLOSINGS } from './resolves.ts';

const DAY = '2026-10-13';
const row = (r: Partial<LedgerRow> & { id: string; kind: string }): LedgerRow => ({ ts: `${DAY}T09:00:00Z`, date: DAY, text: `row ${r.id}`, ...r }) as LedgerRow;
const seed = (): LedgerRow[] => [
    row({ id: 'qgat', kind: 'question', text: 'which store?', gate: 'ticket:acme-1' }),
    row({ id: 'qtkt', kind: 'wip', queued: true, text: 'queued thing', ticket: 'acme-2' }),
    row({ id: 'qbrn', kind: 'question', text: 'ship feat/acme-3-widget as is?' }),
    row({ id: 'qliv', kind: 'question', text: 'ask on feat/acme-4-live', branch: 'feat/acme-4-live', repo: 'shop-api' }),
    row({ id: 'wip1', kind: 'wip', text: 'running work', ticket: 'acme-2', gate: 'ticket:acme-1' }),
    row({ id: 'qnil', kind: 'question', text: 'unknowable', gate: 'ticket:acme-9' }),
];
const lookups = (over: Partial<AgeOutLookups> = {}): AgeOutLookups => ({
    pr: () => null,
    ticket: (id) => ({ 'acme-1': 'closed', 'acme-2': 'closed', 'acme-9': null }[id] ?? 'open'),
    branch: (_repo, name) => (name === 'feat/acme-3-widget' ? 'merged' : name === 'feat/acme-4-live' ? 'live' : null),
    ...over,
});
const items = (rows: LedgerRow[]) => fold(rows, null).items;

test('proposeCloses names cleared gates and closed tickets as verified, a merged branch as a flag, and only awaiting or queued rows', () => {
    const p = proposeCloses(items(seed()), DAY, lookups());
    assert.deepEqual(p.map((x) => [x.id, x.basis, x.autoClose]), [['qgat', 'gate', true], ['qtkt', 'ticket', true], ['qbrn', 'branch', false]]);
    assert.ok(!p.some((x) => x.id === 'wip1'), 'an in-flight row is never proposed: whoever did the work closes it');
});

test('a null lookup proposes nothing, and a live branch proposes nothing', () => {
    const p = proposeCloses(items(seed()), DAY, lookups({ ticket: () => null, branch: () => null }));
    assert.deepEqual(p, []);
});

test('namedBranch prefers the row field, then a conventional name in the text', () => {
    assert.equal(namedBranch(row({ id: 'a', kind: 'question', branch: 'feat/x-1', text: 'on fix/y-2?' })), 'feat/x-1');
    assert.equal(namedBranch(row({ id: 'a', kind: 'question', text: 'merge fix/y-2 now?' })), 'fix/y-2');
    assert.equal(namedBranch(row({ id: 'a', kind: 'question', text: 'no branch here' })), undefined);
});

test('proposalLines reports counts, and is empty with no proposals', () => {
    assert.deepEqual(proposalLines([]), []);
    const lines = proposalLines(proposeCloses(items(seed()), DAY, lookups()));
    assert.match(lines[0], /3; 2 verified/);
    assert.equal(lines.length, 4);
});

function ctxFor(rows: LedgerRow[]): CloseContext {
    let n = 0;
    return {
        readLedger: () => rows,
        append: <E>(entry: E): E => { rows.push(entry as LedgerRow); return entry; },
        newId: () => `n${++n}`,
        fold: (entries) => fold(entries, null),
        today: () => DAY,
        now: () => `${DAY}T10:00:00Z`,
    };
}

test('applyProposals closes only the verified proposals, with the evidence in the closing row', () => {
    const rows = seed();
    const closed = applyProposals(ctxFor(rows), proposeCloses(items(rows), DAY, lookups()));
    assert.deepEqual(closed, ['qgat', 'qtkt']);
    const open = items(rows).filter(isOpen).map((i) => i.id);
    assert.ok(open.includes('qbrn'), 'a merged-branch flag stays open for a person to confirm');
    assert.ok(!open.includes('qgat') && !open.includes('qtkt'));
    assert.match(String(rows.find((r) => r.closes === 'qgat')?.text), /aged out: gate cleared/);
    assert.deepEqual(applyProposals(ctxFor(rows), proposeCloses(items(rows), DAY, lookups())), [], 'idempotent: a second run closes nothing more');
});

test('--resolves closes awaiting and queued rows as resolved; --supersedes and --folds drop them pointing at the new row', () => {
    for (const c of CLOSINGS) {
        const rows = seed();
        const ctx = ctxFor(rows);
        const plan = planClosing(ctx, ['qbrn', 'qtkt']);
        assert.equal(planRefusal(c.flag, plan), null);
        const r = applyClosing(ctx, 'newrow', plan, c);
        assert.equal(r.closed.length, 2);
        const closer = rows.find((x) => x.closes === 'qbrn');
        assert.equal(closer?.kind, c.kind);
        assert.match(String(closer?.text), new RegExp(`${c.phrase} newrow`));
    }
});

test('planRefusal stops on an in-flight row or an unknown id, so nothing is written', () => {
    const ctx = ctxFor(seed());
    assert.match(String(planRefusal('resolves', planClosing(ctx, ['wip1']))), /in flight/);
    assert.match(String(planRefusal('folds', planClosing(ctx, ['nope']))), /names no item: nope/);
});

test('chosenClosing allows at most one flag', () => {
    const on = (...f: string[]) => (flag: string) => f.includes(flag);
    assert.equal(chosenClosing(on()), null);
    assert.equal(chosenClosing(on('folds'))?.['flag' as never], 'folds');
    assert.equal(chosenClosing(on('folds', 'resolves')), 'many');
});
