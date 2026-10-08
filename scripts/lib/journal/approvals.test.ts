// Run: node --test scripts/lib/journal/approvals.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerRow } from '../ledger-core.ts';
import { parseArgs } from './args.ts';
import {
    approvalMap, approvalsText, approvalsWindow, collectApprovals, isDate, isoWeek, shiftDay,
    DELEGATION_LEVELS, HARD_LIMIT_AREAS, PROPOSAL_THRESHOLD, nextDelegationLevel, proposeDelegations,
} from './approvals.ts';
import type { ApprovalEvidence, DecisionArea, DelegationLevel, Digest } from './approvals.ts';

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
    assert.deepEqual(g.reversals, []);
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

const NOW = '2026-10-03';
const BOUNDS = { since: '2026-10-01', now: NOW };

function oneOffs(area: string, ids: string[], date = '2026-10-02'): ApprovalEvidence[] {
    return ids.map((id) => ({ id, area, kind: 'one-off' as const, date }));
}

test('delegation levels are the seven names, and the proposal threshold is the named constant', () => {
    assert.deepEqual(DELEGATION_LEVELS, ['tell', 'sell', 'consult', 'agree', 'advise', 'inquire', 'delegate']);
    assert.equal(PROPOSAL_THRESHOLD, 3);
    assert.deepEqual(HARD_LIMIT_AREAS, ['protected branches', 'attribution', 'secrets', 'frozen tracker labels']);
    DELEGATION_LEVELS.forEach((level, i) => {
        const next = nextDelegationLevel(level);
        assert.equal(next, i === DELEGATION_LEVELS.length - 1 ? undefined : DELEGATION_LEVELS[i + 1]);
    });
});

test('three one-off approvals and no reversal propose the next level only, citing those ids', () => {
    const evidence = oneOffs('lane', ['o1', 'o2', 'o3']);
    for (let i = 0; i < DELEGATION_LEVELS.length; i++) {
        const level: DelegationLevel = DELEGATION_LEVELS[i];
        const got = proposeDelegations([{ name: 'lane', level }], evidence, BOUNDS);
        if (i === DELEGATION_LEVELS.length - 1) {
            assert.deepEqual(got, []);
        } else {
            assert.deepEqual(got, [{ area: 'lane', from: level, to: DELEGATION_LEVELS[i + 1], evidence: ['o1', 'o2', 'o3'] }]);
        }
    }
});

test('fewer than the threshold, a reversal in the window, or a repeated id is not a proposal', () => {
    const area: DecisionArea = { name: 'lane', level: 'tell' };
    const short = oneOffs('lane', Array.from({ length: PROPOSAL_THRESHOLD - 1 }, (_, i) => `low${i}`));
    assert.deepEqual(proposeDelegations([area], short, BOUNDS), []);
    const reversed: ApprovalEvidence[] = [
        ...oneOffs('lane', ['o1', 'o2', 'o3']),
        { id: 'r1', area: 'lane', kind: 'reversal', date: '2026-10-02' },
    ];
    assert.deepEqual(proposeDelegations([area], reversed, BOUNDS), []);
    assert.deepEqual(proposeDelegations([area], oneOffs('lane', ['same', 'same', 'same']), BOUNDS), []);
    assert.deepEqual(proposeDelegations([area], [...oneOffs('lane', ['o1', 'o2']), { id: '', area: 'lane', kind: 'one-off', date: '2026-10-02' }], BOUNDS), []);
});

test('a reversal outside the injected now does not count, and neither does a one-off after now', () => {
    const area: DecisionArea = { name: 'lane', level: 'consult' };
    const futureReversal: ApprovalEvidence[] = [
        ...oneOffs('lane', ['o1', 'o2', 'o3'], '2026-10-01'),
        { id: 'r-future', area: 'lane', kind: 'reversal', date: '2026-10-04' },
    ];
    assert.deepEqual(proposeDelegations([area], futureReversal, BOUNDS), [{ area: 'lane', from: 'consult', to: 'agree', evidence: ['o1', 'o2', 'o3'] }]);
    const pastReversal: ApprovalEvidence[] = [
        ...oneOffs('lane', ['o1', 'o2', 'o3']),
        { id: 'r-past', area: 'lane', kind: 'reversal', date: '2026-09-30' },
    ];
    assert.deepEqual(proposeDelegations([area], pastReversal, BOUNDS), [{ area: 'lane', from: 'consult', to: 'agree', evidence: ['o1', 'o2', 'o3'] }]);
    const late = oneOffs('lane', ['o1', 'o2']).concat({ id: 'o3', area: 'lane', kind: 'one-off', date: '2026-10-04' });
    assert.deepEqual(proposeDelegations([area], late, BOUNDS), []);
});

test('a reversal in one area does not block another, and an area absent from the input is not invented', () => {
    const evidence: ApprovalEvidence[] = [
        ...oneOffs('alpha', ['a1', 'a2', 'a3']),
        ...oneOffs('beta', ['b1', 'b2', 'b3']),
        { id: 'rb', area: 'beta', kind: 'reversal', date: '2026-10-02' },
    ];
    assert.deepEqual(proposeDelegations([{ name: 'alpha', level: 'tell' }, { name: 'beta', level: 'tell' }], evidence, BOUNDS), [
        { area: 'alpha', from: 'tell', to: 'sell', evidence: ['a1', 'a2', 'a3'] },
    ]);
    assert.deepEqual(proposeDelegations([], evidence, BOUNDS), []);
});

test('hard limits stay at tell and are never proposed, including a differently cased name', () => {
    for (const name of HARD_LIMIT_AREAS) {
        const evidence = oneOffs(name, ['h1', 'h2', 'h3', 'h4']);
        assert.deepEqual(proposeDelegations([{ name, level: 'agree' }], evidence, BOUNDS), []);
        assert.deepEqual(proposeDelegations([{ name: name.toUpperCase(), level: 'sell' }], evidence, BOUNDS), []);
    }
    assert.deepEqual(proposeDelegations([{ name: 'Secrets', level: 'inquire' }], oneOffs('Secrets', ['s1', 's2', 's3']), BOUNDS), []);
});

test('collectApprovals ignores an approval value that is not standing or one-off, including inherited object keys', () => {
    const odd: LedgerRow[] = ['constructor', 'toString', '__proto__', 'bogus'].map((approval, i) => ({ id: `odd${i}`, kind: 'decision', date: '2026-10-02', text: 'hand edited', approval }));
    const g = collectApprovals(odd, { since: '2026-09-27', until: TODAY });
    assert.deepEqual([g.standing, g.oneOff], [[], []]);
});

function digest(oneOff: Digest['oneOff'], extra: Partial<Digest> = {}): Digest {
    return { standing: [], oneOff, untagged: [], reversals: [], ...extra };
}

test('approvalsText lists hard limits and proposes the next level from one-off scopes, using the injected clock', () => {
    const window = { since: '2026-10-01', until: '2026-10-10' };
    const qualifying = digest(['o1', 'o2', 'o3'].map((id) => ({ id, date: '2026-10-02', text: 'allow it', scope: 'lane', refs: [] })));
    const text = approvalsText(qualifying, window, '2026-W40', () => NOW);
    assert.match(text, /## Delegation proposals/);
    for (const name of HARD_LIMIT_AREAS) assert.match(text, new RegExp(`- \`${name}\` fixed at tell`));
    assert.match(text, /^- `lane` tell -> sell \(evidence: `o1`, `o2`, `o3`\)$/m);
    assert.doesNotMatch(text, /lane tell -> consult/);
    assert.doesNotMatch(text, /lane .*delegate/);

    const raised = approvalsText(qualifying, window, '2026-W40', () => NOW, [{ name: 'lane', level: 'consult' }]);
    assert.match(raised, /^- `lane` consult -> agree \(evidence: `o1`, `o2`, `o3`\)$/m);
    assert.doesNotMatch(raised, /lane consult -> inquire/);

    const late = digest([
        { id: 'o1', date: '2026-10-01', scope: 'lane', refs: [] },
        { id: 'o2', date: '2026-10-02', scope: 'lane', refs: [] },
        { id: 'o3', date: '2026-10-04', scope: 'lane', refs: [] },
    ]);
    const lateText = approvalsText(late, window, '2026-W40', () => NOW);
    assert.match(lateText, /_none_\n\n## Untagged decisions/);
    assert.doesNotMatch(lateText, /->/);
    const untilFirst = approvalsText(qualifying, { since: '2026-10-01', until: '2026-10-01' }, '2026-W40', () => NOW);
    assert.match(untilFirst, /_none_\n\n## Untagged decisions/);
    assert.doesNotMatch(untilFirst, /->/);
});

test('approvalsText never proposes a hard limit or a standing grant, and a collected reversal blocks the area', () => {
    const window = { since: '2026-10-01', until: NOW };
    const secrets = digest(['h1', 'h2', 'h3'].map((id) => ({ id, date: '2026-10-02', scope: 'Secrets', refs: [] })));
    const secretText = approvalsText(secrets, window, '2026-W40', () => NOW);
    assert.match(secretText, /`secrets` fixed at tell/);
    assert.doesNotMatch(secretText, /->/);

    const standing = digest([], {
        standing: ['s1', 's2', 's3'].map((id) => ({ id, date: '2026-10-02', scope: 'lane', refs: [] })),
    });
    assert.doesNotMatch(approvalsText(standing, window, '2026-W40', () => NOW), /->/);

    const rowsWithReversal: LedgerRow[] = [
        { id: 'o1', kind: 'decision', date: '2026-10-01', text: 'once', approval: 'one-off', scope: 'lane' },
        { id: 'o2', kind: 'decision', date: '2026-10-02', text: 'twice', approval: 'one-off', scope: 'lane' },
        { id: 'o3', kind: 'decision', date: '2026-10-03', text: 'thrice', approval: 'one-off', scope: 'lane' },
        { id: 'r1', kind: 'decision', date: '2026-10-03', text: 'take it back', reversal: true, scope: 'lane' },
    ];
    const collected = collectApprovals(rowsWithReversal, window);
    assert.deepEqual(collected.reversals.map((row) => row.id), ['r1']);
    assert.deepEqual(collected.oneOff.map((row) => row.id), ['o1', 'o2', 'o3']);
    const blocked = approvalsText(collected, window, '2026-W40', () => NOW);
    assert.doesNotMatch(blocked, /->/);
    assert.doesNotMatch(blocked, /evidence:.*`r1`/);

    const open = collectApprovals(rowsWithReversal.slice(0, 3), window);
    assert.match(approvalsText(open, window, '2026-W40', () => NOW), /^- `lane` tell -> sell \(evidence: `o1`, `o2`, `o3`\)$/m);
});
