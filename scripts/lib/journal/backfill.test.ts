// Run: node --test scripts/lib/journal/backfill.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold } from '../ledger-core.ts';
import type { LedgerRow, Registry } from '../ledger-core.ts';
import { backfillEvidence, backfillProposals, candidateStreams, dominant, proposalFor } from './backfill.ts';
import type { BackfillContext } from './backfill.ts';

const D = '2026-10-03';
const at = (n: number): string => `${D}T10:${String(n).padStart(2, '0')}:00Z`;
const registry: Registry = {
    streams: { Alpha: { aliases: ['widgets'], status: 'active' }, Beta: { aliases: [], status: 'active' }, Old: { aliases: [], status: 'archived' } },
    hasStreams: true,
    models: undefined,
};

/** Five tagged Alpha items in repo r1 and one Beta item, then untagged items to propose for. */
const rows: LedgerRow[] = [
    ...[1, 2, 3, 4, 5].map((n): LedgerRow => ({ id: `a${n}00`, kind: 'wip', ts: at(n), date: D, text: `alpha work ${n}`, stream: 'Alpha', repo: 'r1', ticket: 'FAKE-1' })),
    { id: 'b100', kind: 'wip', ts: at(6), date: D, text: 'beta work', stream: 'Beta', repo: 'r2' },
    { id: 'u100', kind: 'wip', ts: at(7), date: D, text: 'more FAKE-1 work', repo: 'r1' },
    { id: 'u200', kind: 'wip', ts: at(8), date: D, text: 'about widgets', repo: 'r9' },
    { id: 'u300', kind: 'wip', ts: at(9), date: D, text: 'nothing matches', repo: 'r7' },
];

const ctx: BackfillContext = { readLedger: () => rows, fold: (entries) => fold(entries, registry), loadRegistry: () => registry };

test('backfillEvidence counts streams by repo and ticket, and dominant picks the top stream unless tied', () => {
    const ev = backfillEvidence(ctx.fold(rows).items);
    assert.deepEqual([...(ev.byRepo.get('r1') ?? [])], [['Alpha', 5]]);
    assert.deepEqual(dominant(ev.byTicket.get('FAKE-1')), { stream: 'Alpha', n: 5, total: 5, share: 1 });
    assert.equal(dominant(new Map([['A', 2], ['B', 2]])), null);
    assert.equal(dominant(undefined), null);
});

test('candidateStreams lists registered, unarchived and used streams', () => {
    assert.deepEqual([...candidateStreams(ctx, ctx.fold(rows).items, [])].sort(), ['Alpha', 'Beta']);
    assert.deepEqual([...candidateStreams(ctx, ctx.fold(rows).items, ['Beta'])], ['Alpha']);
});

test('backfillProposals files untagged items by ticket, keyword and repo evidence, and leaves the rest without a proposal', () => {
    const { proposals, untagged } = backfillProposals(ctx);
    assert.equal(untagged, 3);
    const by = Object.fromEntries(proposals.map((p) => [p.item.id, [p.stream, p.confidence, p.rules.join('+')]]));
    assert.deepEqual(by.u100, ['Alpha', 'high', 'ticket+repo']);
    assert.deepEqual(by.u200, ['Alpha', 'medium', 'keyword']);
    assert.deepEqual(by.u300, [null, null, '']);
});

test('proposalFor returns null with no vote and caps a disagreement at low', () => {
    const items = ctx.fold(rows).items;
    const ev = backfillEvidence(items);
    const item = items.find((i) => i.id === 'u300');
    assert.ok(item);
    assert.equal(proposalFor(item, ev, [], new Set(['Alpha'])), null);
    const split = proposalFor({ ...item, text: 'FAKE-1 but also beta' }, ev, [{ stream: 'Beta', re: /beta/ }], new Set(['Alpha', 'Beta']));
    assert.deepEqual([split?.stream, split?.confidence, split?.conflict], ['Alpha', 'low', true]);
});
