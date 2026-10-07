// Run: node --test scripts/prs-snapshot.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGhStub, paged, prNode } from './lib/gh-stub.ts';

// Hermetic: never read the user's config file (see local-config.ts).
process.env.MAESTRO_LOCAL_CONFIG = '';
import type { StoredPr } from './prs-snapshot.ts';
import type { VerdictRow } from './review-verdict.ts';
const { readiness, readyLines, requerySiblings } = await import('./prs-snapshot.ts');

const SCRIPT = new URL('./prs-snapshot.ts', import.meta.url).pathname;

function run(...args: string[]) {
    return runWith(process.env, ...args);
}

function runWith(env: NodeJS.ProcessEnv, ...args: string[]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

function fixture(dir: string, name: string, snapshot: unknown): string {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(snapshot));
    return p;
}

function pr(overrides: Partial<StoredPr> = {}): StoredPr {
    return {
        key: 'org/repo#1',
        repo: 'org/repo',
        number: 1,
        title: 'x',
        url: 'https://github.com/org/repo/pull/1',
        isDraft: false,
        headRefName: 'feat',
        baseRefName: 'develop',
        updatedAt: '2026-09-24T00:00:00Z',
        reviewDecision: 'REVIEW_REQUIRED',
        reviewers: [],
        reviews: [],
        threads: [],
        commentTotal: 0,
        ...overrides,
    };
}

test('identical snapshots report no actionable changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const snap = { takenAt: 't', prs: [pr()] };
    const r = run('diff', fixture(dir, 'old.json', snap), fixture(dir, 'new.json', snap));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /No actionable changes/);
});

test('a new human review is reported by author and state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const oldSnap = { takenAt: 't', prs: [pr()] };
    const newSnap = {
        takenAt: 't2',
        prs: [pr({ reviews: [{ author: 'alice', state: 'CHANGES_REQUESTED', submittedAt: 'a' }] })],
    };
    const r = run('diff', fixture(dir, 'old.json', oldSnap), fixture(dir, 'new.json', newSnap));
    assert.match(r.out, /alice CHANGES_REQUESTED/);
});

test('diffing against an older snapshot without reviews or threads does not throw and reports what is new', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const { reviews: _r, threads: _t, ...legacy } = pr();
    const newSnap = {
        takenAt: 't2',
        prs: [pr({ reviews: [{ author: 'alice', state: 'APPROVED', submittedAt: 'a' }], threads: [{ id: 'T1', isResolved: false, isOutdated: false, author: 'bob' }] })],
    };
    const r = run('diff', fixture(dir, 'old.json', { takenAt: 't', prs: [legacy] }), fixture(dir, 'new.json', newSnap));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /alice APPROVED/);
    assert.match(r.out, /new thread opened by bob/);
});

test('a bot review is summarised in the count line, never itemised', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const oldSnap = { takenAt: 't', prs: [pr()] };
    const newSnap = {
        takenAt: 't2',
        prs: [pr({ reviews: [{ author: 'aikido-pr-checks', state: 'COMMENTED', submittedAt: 'a' }] })],
    };
    const r = run('diff', fixture(dir, 'old.json', oldSnap), fixture(dir, 'new.json', newSnap));
    assert.doesNotMatch(r.out, /aikido/);
    assert.match(r.out, /1 bot-only update/);
});

test('a reviewDecision flip is reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const oldSnap = { takenAt: 't', prs: [pr({ reviewDecision: 'REVIEW_REQUIRED' })] };
    const newSnap = { takenAt: 't2', prs: [pr({ reviewDecision: 'CHANGES_REQUESTED' })] };
    const r = run('diff', fixture(dir, 'old.json', oldSnap), fixture(dir, 'new.json', newSnap));
    assert.match(r.out, /REVIEW_REQUIRED -> CHANGES_REQUESTED/);
});

test('a new unresolved human thread is reported; a bot thread only bumps the count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const oldSnap = { takenAt: 't', prs: [pr()] };
    const newSnap = {
        takenAt: 't2',
        prs: [pr({
            threads: [
                { id: 't1', isResolved: false, isOutdated: false, author: 'bob' },
                { id: 't2', isResolved: false, isOutdated: false, author: 'copilot-pull-request-reviewer' },
            ],
        })],
    };
    const r = run('diff', fixture(dir, 'old.json', oldSnap), fixture(dir, 'new.json', newSnap));
    assert.match(r.out, /new thread opened by bob/);
    assert.doesNotMatch(r.out, /copilot/);
    assert.match(r.out, /1 bot-only update/);
});

test('a resolved new thread is not reported (nothing actionable left)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const oldSnap = { takenAt: 't', prs: [pr()] };
    const newSnap = {
        takenAt: 't2',
        prs: [pr({ threads: [{ id: 't1', isResolved: true, isOutdated: false, author: 'bob' }] })],
    };
    const r = run('diff', fixture(dir, 'old.json', oldSnap), fixture(dir, 'new.json', newSnap));
    assert.match(r.out, /No actionable changes/);
});

test('a draft promoted to ready is reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const oldSnap = { takenAt: 't', prs: [pr({ isDraft: true })] };
    const newSnap = { takenAt: 't2', prs: [pr({ isDraft: false })] };
    const r = run('diff', fixture(dir, 'old.json', oldSnap), fixture(dir, 'new.json', newSnap));
    assert.match(r.out, /draft promoted to ready/);
});

test('a PR missing from the new snapshot is reported merged or closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const oldSnap = { takenAt: 't', prs: [pr()] };
    const newSnap = { takenAt: 't2', prs: [] };
    const r = run('diff', fixture(dir, 'old.json', oldSnap), fixture(dir, 'new.json', newSnap));
    assert.match(r.out, /no longer open \(merged or closed\)/);
});

test('a brand-new PR with no prior entry is not reported as a change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const oldSnap = { takenAt: 't', prs: [] };
    const newSnap = { takenAt: 't2', prs: [pr({ key: 'org/repo#2', number: 2 })] };
    const r = run('diff', fixture(dir, 'old.json', oldSnap), fixture(dir, 'new.json', newSnap));
    assert.match(r.out, /No actionable changes/);
});

test('missing arguments print usage and exit non-zero', () => {
    const r = run('diff', '/tmp/does-not-matter.json');
    assert.notEqual(r.code, 0);
    assert.match(r.err, /Usage: prs-snapshot\.ts diff/);
});

test('--diff reads every search page: PRs past the 50th are not "no longer open"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const nodes = Array.from({ length: 53 }, (_, i) => prNode(i + 1));
    const prs = nodes.map((n) => pr({ key: `org/repo#${n.number}`, number: n.number, url: n.url }));
    mkdirSync(join(dir, 'Projects', 'dev-env', 'Journal'), { recursive: true });
    writeFileSync(join(dir, 'Projects', 'dev-env', 'Journal', 'prs-snapshot.json'), JSON.stringify({ takenAt: 't', prs }));
    const env = installGhStub({ pages: paged(nodes) });
    const r = runWith(env, '--diff', '--dry-run', '--vault', dir);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /no longer open/);
    assert.match(r.out, /No actionable changes/);
});

// ── readiness ───────────────────────────────────────────────────────────────

const good = (o: Partial<StoredPr> = {}): StoredPr => pr({ reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', threadsComplete: true, ...o });
const thread = (id: string, isResolved: boolean) => ({ id, isResolved, isOutdated: false, author: 'rev' });

test('a PR is ready only when approved, not a draft, with zero unresolved threads, MERGEABLE, and every condition says why when it fails', () => {
    assert.deepEqual(readiness(good()), { ready: true, reasons: [] });
    assert.deepEqual(readiness(good({ threads: [thread('a', true)] })).ready, true, 'resolved threads do not count');
    const why = (o: Partial<StoredPr>) => readiness(good(o)).reasons.join('|');
    assert.match(why({ threads: [thread('a', false), thread('b', false), thread('c', true)] }), /2 unresolved review thread\(s\)/);
    assert.match(why({ mergeable: 'CONFLICTING' }), /merge conflict/);
    assert.match(why({ mergeable: 'UNKNOWN' }), /mergeable state UNKNOWN/);
    assert.match(why({ mergeable: undefined }), /mergeable state unknown/, 'an old snapshot with no field is not ready');
    assert.match(why({ threadsComplete: false }), /not all read/);
    assert.match(why({ isDraft: true }), /draft/);
    assert.match(why({ reviewDecision: 'CHANGES_REQUESTED' }), /not approved \(CHANGES_REQUESTED\)/);
});

test('in a twin-flow repo a release-candidate PR is held while its integration twin is open, and only then', () => {
    const rc = good({ key: 'org/repo#2', number: 2, baseRefName: 'staging', headRefName: 'feat/x' });
    const dev = good({ key: 'org/repo#1', number: 1, baseRefName: 'develop', headRefName: 'feat/x' });
    assert.match(readiness(rc, [rc, dev], ['org/repo']).reasons.join('|'), /blocked on develop twin #1/);
    assert.equal(readiness(rc, [rc], ['org/repo']).ready, true, 'twin merged: not in the open list');
    assert.equal(readiness(rc, [rc, dev], []).ready, true, 'repo not in twin_flow_repos: rule off');
    assert.equal(readiness(dev, [rc, dev], ['org/repo']).ready, true, 'the integration PR itself is not held');
});

test('readyLines never puts a PR with an open thread or a conflict in the ready bucket, and lists approved ones that are held with why', () => {
    const snap = { prs: [
        good({ key: 'o/r#1', number: 1 }),
        good({ key: 'o/r#2', number: 2, threads: [thread('t', false)] }),
        good({ key: 'o/r#3', number: 3, mergeable: 'CONFLICTING' }),
        pr({ key: 'o/r#4', number: 4, reviewDecision: 'REVIEW_REQUIRED' }),
    ] };
    const lines = readyLines(snap, []).join('\n');
    assert.match(lines, /Ready to merge \(1\):\n  o\/r#1 /);
    assert.match(lines, /Approved but not ready \(2\):/);
    assert.match(lines, /o\/r#2 — 1 unresolved review thread\(s\)/);
    assert.match(lines, /o\/r#3 — merge conflict/);
    assert.doesNotMatch(lines, /o\/r#4/, 'an unapproved PR is neither ready nor held');
});

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const botFixed = (o: Partial<StoredPr> = {}): StoredPr => good({ headSha: HEAD, threads: [{ id: 'b', isResolved: true, isOutdated: false, author: 'copilot-pull-request-reviewer' }], ...o });
const verdict = (v: 'SHIP IT' | 'NEEDS WORK', over: Partial<VerdictRow> = {}): VerdictRow => ({ pr: 'org/repo#1', head: HEAD, verdict: v, reviewer: 'a', fixer: 'b', at: 't', ...over });

test('a PR with resolved bot threads is held until a fresh agent recorded SHIP IT for its current head', () => {
    const why = (p: StoredPr, rows?: VerdictRow[]) => readiness(p, [], [], rows).reasons.join('|');
    assert.match(why(botFixed()), /bot threads resolved, no fresh-agent re-review/);
    assert.match(why(botFixed(), []), /no fresh-agent re-review/);
    assert.deepEqual(readiness(botFixed(), [], [], [verdict('SHIP IT')]), { ready: true, reasons: [] });
    assert.match(why(botFixed(), [verdict('NEEDS WORK')]), /re-review said NEEDS WORK/);
    assert.match(why(botFixed(), [verdict('SHIP IT', { head: 'f'.repeat(40) })]), /no fresh-agent re-review/, 'a push after the verdict needs a new one');
    assert.match(why(botFixed({ headSha: undefined }), [verdict('SHIP IT')]), /head commit unknown/);
});

test('human-resolved threads, and PRs with no resolved bot thread, need no re-review', () => {
    assert.equal(readiness(good({ headSha: HEAD, threads: [thread('a', true)] })).ready, true);
    assert.equal(readiness(good({ headSha: HEAD, threads: [{ id: 'b', isResolved: false, isOutdated: false, author: 'copilot-pull-request-reviewer' }] })).ready, false, 'an open bot thread still blocks');
    assert.equal(readiness(good()).ready, true);
});

test('readyLines carries the re-review reason into the held list', () => {
    const lines = readyLines({ prs: [botFixed({ key: 'org/repo#1' })] }, [], []).join('\n');
    assert.match(lines, /Ready to merge \(0\)/);
    assert.match(lines, /org\/repo#1 — bot threads resolved/);
    assert.match(readyLines({ prs: [botFixed({ key: 'org/repo#1' })] }, [], [verdict('SHIP IT')]).join('\n'), /Ready to merge \(1\)/);
});

test('ready <snapshot> prints the report offline, and a missing argument prints usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const r = run('ready', fixture(dir, 's.json', { prs: [good({ threads: [thread('t', false)] })] }));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Ready to merge \(0\)/);
    assert.match(r.out, /1 unresolved review thread/);
    assert.match(run('ready').err, /Usage: prs-snapshot\.ts ready/);
});

test('--ready on a live fetch reports mergeable and thread state from the board query', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const nodes = [prNode(1, { reviewDecision: 'APPROVED', mergeable: 'MERGEABLE' }), prNode(2, { reviewDecision: 'APPROVED', mergeable: 'CONFLICTING' })];
    const r = runWith(installGhStub({ pages: paged(nodes) }), '--ready', '--dry-run', '--vault', dir);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Ready to merge \(1\):\n  org\/repo#1 /);
    assert.match(r.out, /org\/repo#2 — merge conflict/);
});

test('after a merge, requerySiblings distrusts the cached mergeable of open PRs in that repo until two known answers agree, and leaves other repos alone', () => {
    const prev = { prs: [good({ key: 'a/x#1', repo: 'a/x', number: 1 }), good({ key: 'a/x#2', repo: 'a/x', number: 2 }), good({ key: 'b/y#3', repo: 'b/y', number: 3 })] };
    const curr = () => ({ prs: [good({ key: 'a/x#2', repo: 'a/x', number: 2 }), good({ key: 'b/y#3', repo: 'b/y', number: 3 })] });
    const feed = (answers: (string | null)[]) => { const asked: string[] = []; return { asked, run: (args: string[]) => { asked.push(args[2]); const a = answers.shift(); return a === null ? { status: 1, stdout: '' } : { status: 0, stdout: `${a}\n` }; } }; };

    const settle = curr(); const f = feed(['UNKNOWN', 'CONFLICTING', 'CONFLICTING']);
    assert.deepEqual(requerySiblings(prev, settle, { run: f.run, wait: () => {} }), ['a/x']);
    assert.deepEqual([settle.prs[0].mergeable, settle.prs[1].mergeable], ['CONFLICTING', 'MERGEABLE'], 'the other repo keeps its board value');
    assert.deepEqual(f.asked, ['2', '2', '2'], 'nothing is asked for the other repo');

    const stale = curr(); const g = feed(['MERGEABLE', 'CONFLICTING', 'CONFLICTING']);
    requerySiblings(prev, stale, { run: g.run, wait: () => {} });
    assert.equal(stale.prs[0].mergeable, 'CONFLICTING', 'a first MERGEABLE is not trusted on its own: it may be the cache from before the merge');

    const failing = curr();
    requerySiblings(prev, failing, { run: feed([null]).run, wait: () => {} });
    assert.equal(failing.prs[0].mergeable, 'UNKNOWN', 'a failed lookup fails closed, so the PR is not ready');
    assert.match(readiness(failing.prs[0], failing.prs, []).reasons.join('|'), /mergeable state UNKNOWN/);

    const never = curr();
    requerySiblings(prev, never, { run: feed(['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']).run, wait: () => {} });
    assert.equal(never.prs[0].mergeable, 'UNKNOWN');

    const quiet = curr();
    assert.deepEqual(requerySiblings({ prs: quiet.prs }, quiet, { run: () => { throw new Error('no merge, no asks'); } }), []);
});

test('ready <file> says how old the snapshot is, warns when it is stale, and tolerates a snapshot with no threads field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const old = pr({ key: 'o/r#9', number: 9, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE' });
    delete old.threads;
    const r = run('ready', fixture(dir, 'old.json', { takenAt: new Date(Date.now() - 3 * 36e5).toISOString(), prs: [old] }));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Snapshot taken .*\(180 minutes ago: STALE\)\. Not a merge gate/);
    const fresh = run('ready', fixture(dir, 'new.json', { takenAt: new Date().toISOString(), prs: [] }));
    assert.doesNotMatch(fresh.out, /STALE/);
});

test('stacks <snapshot> flags a stack over the depth cap offline, and a missing argument prints usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const chain = [1, 2, 3, 4].map((n) => pr({ key: `o/r#${n}`, repo: 'o/r', number: n, url: `https://github.com/o/r/pull/${n}`, headRefName: `f${n}`, baseRefName: n === 1 ? 'develop' : `f${n - 1}`, createdAt: new Date().toISOString() }));
    const r = run('stacks', fixture(dir, 's.json', { prs: chain }));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Stacks over the cap \(3 deep, 5 days\): 1/);
    assert.match(r.out, /o\/r: 4 deep: #1 <- #2 <- #3 <- #4\. Stop adding to the top; drive o\/r#1 to merge/);
    assert.match(run('stacks', fixture(dir, 'flat.json', { prs: [chain[0]] })).out, /: none/);
    assert.match(run('stacks').err, /Usage: prs-snapshot\.ts stacks/);
});
