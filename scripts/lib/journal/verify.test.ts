// Run: node --test scripts/lib/journal/verify.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoCommitLedger, verifyLedger } from './verify.ts';
import type { VerifyContext } from './verify.ts';
import { parseLedger } from '../ledger-core.ts';

/** A context over a ledger file holding `lines`. */
function ctxFor(lines: string[], over: Partial<VerifyContext> = {}): VerifyContext {
    const vault = mkdtempSync(join(tmpdir(), 'verify-'));
    const ledgerPath = join(vault, 'ledger.jsonl');
    writeFileSync(ledgerPath, lines.join('\n') + '\n');
    return { ledgerPath, approvals: new Set(['standing', 'one-off']), approvableKinds: new Set(['decision', 'resolved', 'question']), autocommit: false, dryRun: false, vault, ...over };
}

test('verifyLedger reports unparseable lines, duplicate ids, bad approvals and dangling references with their line numbers', () => {
    const { rows, problems } = verifyLedger(ctxFor([
        JSON.stringify({ id: 'aaaa', kind: 'decision' }),
        'not json',
        JSON.stringify({ id: 'aaaa', kind: 'note' }),
        JSON.stringify({ id: 'bbbb', kind: 'done', closes: 'zzzz' }),
        JSON.stringify({ id: 'cccc', kind: 'decision', approval: 'forever' }),
        JSON.stringify({ id: 'dddd', kind: 'approval-tag', approves: 'bbbb', approval: 'standing' }),
    ]));
    assert.equal(rows, 5);
    assert.deepEqual(problems.map((p) => [p.line, p.problem]), [
        [2, 'line does not parse as a JSON object'],
        [3, 'duplicate id (first on line 1)'],
        [4, 'closes refers to zzzz, which does not exist'],
        [5, 'approval "forever" is not one of: standing, one-off'],
        [6, 'approves bbbb, a done row; only decision, resolved, question can be approved'],
    ]);
});

test('a clean ledger has no problems, and the backup commit does nothing when it is off', () => {
    const ctx = ctxFor([JSON.stringify({ id: 'aaaa', kind: 'wip' })]);
    assert.deepEqual(verifyLedger(ctx), { rows: 1, problems: [] });
    assert.equal(autoCommitLedger(ctx, '2026-10-03'), true);
    assert.equal(autoCommitLedger({ ...ctx, autocommit: true, dryRun: true }, '2026-10-03'), true);
});

test('verifyLedger and parseLedger report the same real line number for a malformed line after blank lines', () => {
    const ctx = ctxFor([JSON.stringify({ id: 'aaaa', kind: 'note' }), '', '', 'not json', JSON.stringify({ id: 'bbbb', kind: 'note' })]);
    const seen: number[] = [];
    parseLedger(readFileSync(ctx.ledgerPath, 'utf8'), (n) => seen.push(n));
    assert.deepEqual(seen, [4]);
    assert.deepEqual(verifyLedger(ctx).problems.map((p) => p.line), [4]);
});

test('the backup commit reports "not a git repository root" for a vault path that does not exist, and does not throw', () => {
    const vault = join(mkdtempSync(join(tmpdir(), 'verify-')), 'missing');
    const errors: string[] = [];
    const original = console.error;
    console.error = (m: unknown) => { errors.push(String(m)); };
    try {
        assert.equal(autoCommitLedger({ ...ctxFor([]), autocommit: true, vault }, '2026-10-04'), true);
    } finally { console.error = original; }
    assert.deepEqual(errors, [`ledger_git_autocommit is on but ${vault} is not a git repository root; not committing.`]);
});

test('verify flags ask fields a hand edit made impossible, and passes legacy and well-formed asks', () => {
    const { problems } = verifyLedger(ctxFor([
        JSON.stringify({ id: 'aaaa', kind: 'question', text: 'legacy ask?' }),
        JSON.stringify({ id: 'bbbb', kind: 'question', text: 'ok?', door: 'two-way', default: 'apply', by: '2026-10-09', class: 'standard' }),
        JSON.stringify({ id: 'cccc', kind: 'question', text: 'one-way with a default?', door: 'one-way', default: 'merge' }),
        JSON.stringify({ id: 'dddd', kind: 'question', text: 'bad values?', door: 'maybe', class: 'urgent', by: 'soon' }),
        JSON.stringify({ id: 'eeee', kind: 'note', text: 'not an ask', door: 'maybe' }),
    ]));
    assert.deepEqual(problems.map((p) => [p.line, p.problem]), [
        [3, 'ask field: carries a default but is not a two-way door: the default will never fire'],
        [4, 'ask field: door "maybe" is not one-way or two-way'],
        [4, 'ask field: class "urgent" is not one of: expedite, fixed-date, standard, intangible'],
        [4, 'ask field: by "soon" is not YYYY-MM-DD or an ISO time with a zone'],
    ]);
});

test('verify flags a learned row a hand edit stripped of evidence or gave a secret shape, and passes a well-formed one', () => {
    const ok = { id: 'aaaa', kind: 'learned', text: 'The fake page count is the page length.', learnedKind: 'how-it-works', appliesTo: 'fake-repo:fake-api', evidence: 'spec:1', verifiedAt: '342b177', confidence: 'observed' };
    const { problems } = verifyLedger(ctxFor([
        JSON.stringify(ok),
        JSON.stringify({ ...ok, id: 'bbbb', evidence: undefined }),
        JSON.stringify({ ...ok, id: 'cccc', text: ['pass', 'word=hunter2'].join('') }),
    ]));
    assert.deepEqual(problems.map((p) => p.line), [2, 3]);
    assert.match(problems[0]?.problem ?? '', /^learned: --evidence is required/);
    assert.match(problems[1]?.problem ?? '', /^learned: refused, nothing written \(claim: looks like a secret/);
    assert.ok(problems.every((p) => !p.problem.includes('hunter2')));
});
