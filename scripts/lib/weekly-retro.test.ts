// Run: node --test scripts/lib/weekly-retro.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold } from './ledger-core.ts';
import type { LedgerRow } from './ledger-core.ts';
import { lastExperiment, renderRetro, weeklyRetro } from './weekly-retro.ts';

const NOW = new Date('2026-10-09T12:00:00Z');
const row = (id: string, ts: string, kind: string, extra: Partial<LedgerRow> = {}): LedgerRow => ({ id, ts, date: ts.slice(0, 10), kind, stream: 's', text: `item ${id}`, ...extra });
const retro = (rows: LedgerRow[]) => weeklyRetro(rows, fold(rows, null).items, NOW);

test('stale lists only in-flight items past the cutoff, oldest first; fresh ones stay out', () => {
    const r = retro([row('old', '2026-09-20T00:00:00Z', 'wip'), row('mid', '2026-10-01T00:00:00Z', 'wip'), row('new', '2026-10-08T00:00:00Z', 'wip')]);
    assert.deepEqual(r.stale.map((a) => a.id), ['old', 'mid']);
});

test('queued items are not stale, and a promoted item ages from its promotion', () => {
    const r = retro([
        row('q', '2026-09-01T00:00:00Z', 'wip', { queued: true }),
        row('p', '2026-09-01T00:00:00Z', 'wip', { queued: true }), row('pr', '2026-10-08T00:00:00Z', 'promote', { promotes: 'p' }),
    ]);
    assert.deepEqual(r.stale, []);
});

test('blocked, dropped and done this week are counted apart', () => {
    const r = retro([
        row('b', '2026-10-05T00:00:00Z', 'blocked'),
        row('d', '2026-10-06T00:00:00Z', 'wip'), row('dd', '2026-10-07T00:00:00Z', 'done', { closes: 'd' }),
        row('x', '2026-10-06T00:00:00Z', 'wip'), row('dx', '2026-10-07T00:00:00Z', 'dropped', { closes: 'x' }),
        row('o', '2026-08-01T00:00:00Z', 'wip'), row('do', '2026-08-02T00:00:00Z', 'done', { closes: 'o' }),
    ]);
    assert.deepEqual(r.blocked.map((a) => a.id), ['b']);
    assert.equal(r.done, 1);
    assert.deepEqual(r.dropped.map((a) => a.id), ['x']);
    assert.equal(r.stale.length, 0);
});

test('the latest experiment is shown; a later verdict settles it and an earlier one does not', () => {
    const notes = [
        row('v0', '2026-09-01T00:00:00Z', 'note', { text: 'Retro verdict: drop too early' }),
        row('e1', '2026-09-20T00:00:00Z', 'note', { text: 'Retro experiment: batch asks' }),
        row('e2', '2026-10-02T00:00:00Z', 'note', { text: 'retro experiment: cap stacks at 3' }),
    ];
    assert.deepEqual(lastExperiment(notes), { id: 'e2', text: 'cap stacks at 3', date: '2026-10-02', verdict: null, reason: '' });
    const settled = lastExperiment([...notes, row('v1', '2026-10-09T00:00:00Z', 'note', { text: 'Retro verdict: keep it held' })]);
    assert.deepEqual([settled?.verdict, settled?.reason], ['keep', 'it held']);
    assert.equal(lastExperiment([]), null);
});

test('renderRetro names the gaps the ledger cannot fill and says undecided when there is no verdict', () => {
    const rows = [row('e', '2026-10-02T00:00:00Z', 'note', { text: 'Retro experiment: one thing' }), row('o', '2026-09-01T00:00:00Z', 'wip')];
    const text = renderRetro(retro(rows));
    assert.match(text, /last experiment {2}one thing \(2026-10-02\) - undecided: keep or drop it/);
    assert.match(text, /o {2}item o/);
    assert.match(text, /reopened tickets, corrections from the user, cost misses/);
    assert.match(renderRetro(retro([])), /last experiment {2}none recorded/);
});
