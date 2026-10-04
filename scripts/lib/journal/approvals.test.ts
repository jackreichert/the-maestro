// Run: node --test scripts/lib/journal/approvals.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerRow } from '../ledger-core.ts';
import { parseArgs } from './args.ts';
import { approvalMap, approvalsText, approvalsWindow, collectApprovals, isDate, isoWeek, shiftDay } from './approvals.ts';

const TODAY = '2026-10-03';

/** A window context over a fake command line; `die` throws so a usage error is catchable. */
function windowFor(...argv: string[]) {
    const { arg, has } = parseArgs(['approvals', ...argv]);
    const die = (message: string): never => { throw new Error(message); };
    return approvalsWindow({ arg, has, die, today: () => TODAY });
}

test('isoWeek labels by the Thursday, and isDate rejects dates that do not read back unchanged', () => {
    assert.equal(isoWeek('2026-01-01'), '2026-W01');
    assert.equal(isoWeek('2026-12-31'), '2026-W53');
    assert.equal(isoWeek('2027-01-01'), '2026-W53');
    assert.equal(isDate('2026-02-28'), true);
    assert.equal(isDate('2026-02-30'), false);
    assert.equal(isDate('26-02-28'), false);
    assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
});

test('approvalsWindow defaults to the seven days ending today, and rejects bad input through die', () => {
    assert.deepEqual(windowFor(), { since: '2026-09-27', until: TODAY });
    assert.deepEqual(windowFor('--days', '3', '--until', '2026-10-01'), { since: '2026-09-29', until: '2026-10-01' });
    assert.deepEqual(windowFor('--since', '2026-09-01'), { since: '2026-09-01', until: TODAY });
    assert.throws(() => windowFor('--since', '2026-10-09'), /is after --until/);
    assert.throws(() => windowFor('--days', '0'), /whole number/);
    assert.throws(() => windowFor('--until', '2026-02-30'), /--until must be YYYY-MM-DD/);
});

const rows: LedgerRow[] = [
    { id: 'aaaa', kind: 'decision', date: '2026-10-01', text: 'allow the sweep', approval: 'standing', scope: 'worktrees only', refs: ['notes.md'] },
    { id: 'bbbb', kind: 'decision', date: '2026-10-02', text: 'one time push' },
    { id: 'cccc', kind: 'approval-tag', date: '2026-10-02', approves: 'bbbb', approval: 'one-off' },
    { id: 'dddd', kind: 'decision', date: '2026-10-02', text: 'no approval touches this', repo: 'proj' },
    { id: 'eeee', kind: 'decision', date: '2026-08-01', text: 'out of window', approval: 'standing' },
];

test('collectApprovals groups grants, follows approval-tag rows, and lists untagged decisions', () => {
    const g = collectApprovals(rows, { since: '2026-09-27', until: TODAY });
    assert.deepEqual(g.standing.map((a) => [a.id, a.scope, a.refs]), [['aaaa', 'worktrees only', ['notes.md']]]);
    assert.deepEqual(g.oneOff.map((a) => [a.id, a.taggedBy]), [['bbbb', 'cccc']]);
    assert.deepEqual(g.untagged.map((a) => [a.id, a.repo]), [['dddd', 'proj']]);
});

test('approvalMap takes the latest approval set per row and approvalsText renders the three sections', () => {
    assert.deepEqual([...approvalMap(rows)], [['aaaa', 'standing'], ['bbbb', 'one-off'], ['eeee', 'standing']]);
    const window = { since: '2026-09-27', until: TODAY };
    const text = approvalsText(collectApprovals(rows, window), window, isoWeek(TODAY), () => TODAY);
    assert.match(text, /^---\ntype: review\nstatus: draft\nweek: 2026-W40\ngenerated: 2026-10-03\n/);
    assert.match(text, /### 2026-10-01 `aaaa`\n\nallow the sweep\n\n- Scope: worktrees only\n- Ref: notes\.md/);
    assert.match(text, /- 2026-10-02 `bbbb` one time push \(ref: none\)/);
    assert.match(text, /## Untagged decisions[\s\S]*- 2026-10-02 `dddd` no approval touches this/);
});

test('collectApprovals ignores an approval value that is not standing or one-off, including inherited object keys', () => {
    const odd: LedgerRow[] = ['constructor', 'toString', '__proto__', 'bogus'].map((approval, i) => ({ id: `odd${i}`, kind: 'decision', date: '2026-10-02', text: 'hand edited', approval }));
    const g = collectApprovals(odd, { since: '2026-09-27', until: TODAY });
    assert.deepEqual([g.standing, g.oneOff], [[], []]);
});
