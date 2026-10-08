// Run: node --test scripts/lib/journal/triage.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { triageChecklist, triageItems, triageLines, triageReport } from './triage.ts';
import type { TriageContext } from './triage.ts';

const D = '2026-10-03';
const rows: LedgerRow[] = [
    { id: 'aaaa', kind: 'decision', date: D, text: 'never force push', refs: ['/exists.md'] },
    { id: 'bbbb', kind: 'decision', date: D, text: 'rule with no file', approval: 'standing' },
    { id: 'cccc', kind: 'note', date: D, text: 'follow-up: file the ticket for the retry bug' },
    { id: 'dddd', kind: 'wip', date: '2026-09-20', text: 'old work' },
];

const ctx: TriageContext = {
    readLedger: () => rows,
    fold: (entries) => fold(entries, null),
    today: () => D,
    resolveRefFile: (ref) => (ref === '/exists.md' ? ref : null),
};

test('triageItems boxes open items and recent decisions and notes, with the resolved ref and staleness', () => {
    const items = triageItems(ctx, D, D);
    assert.deepEqual(items.map((i) => [i.id, i.box, i.ref, i.stale]), [
        ['aaaa', 1, '/exists.md', false], ['bbbb', 2, null, false], ['cccc', 8, null, false], ['dddd', 7, null, true],
    ]);
    assert.equal(items.find((i) => i.id === 'dddd')?.ageDays, 13);
});

test('triageReport lists blockers for unpromoted records and findings, and the checklist marks what the ledger can tell', () => {
    const t = triageReport(ctx, D);
    assert.deepEqual(t.blockers.map((b) => [b.id, b.why]), [['bbbb', 'not promoted: no --ref that is an existing file'], ['cccc', 'finding with no ticket']]);
    assert.deepEqual(t.applicable, ['aaaa']);
    assert.deepEqual(t.stale.map((s) => s.id), ['dddd']);
    assert.match(t.checklist[0] ?? '', /^\[ \] Every rule or approval/);
    assert.equal(triageChecklist([], []).length, 8);
    const lines = triageLines(t);
    assert.match(lines[0] ?? '', /^Triage — 2026-10-03/);
    assert.ok(lines.includes('Blockers (roll --strict refuses): 2'));
});

test('triage boxes learned rows dated in the window as box 9, shows them under Learnings, and does not block the roll on them', () => {
    const learned: LedgerRow[] = [
        { id: 'eeee', kind: 'learned', date: D, text: 'The fake page count is the page length.', appliesTo: 'fake-repo:fake-api', evidence: 'spec:1' },
        { id: 'ffff', kind: 'learned', date: '2026-09-01', text: 'An older fact outside the window.' },
    ];
    const t = triageReport({ ...ctx, readLedger: () => learned }, D);
    assert.deepEqual(t.items.map((i) => [i.id, i.box]), [['eeee', 9]]);
    assert.deepEqual(t.blockers, []);
    assert.ok(triageLines(t).some((l) => /Box 9 Learnings \(1\)/.test(l)));
    assert.ok(triageLines(t).some((l) => /^\s+eeee  The fake page count/.test(l)));
});
