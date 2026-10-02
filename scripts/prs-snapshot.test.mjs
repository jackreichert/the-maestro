// Run: node --test scripts/prs-snapshot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGhStub, paged, prNode } from './lib/gh-stub.mjs';

const { readiness, readyLines, requerySiblings } = await import('./prs-snapshot.mjs');

// Hermetic: never read the user's config file (see local-config.mjs).
process.env.MAESTRO_LOCAL_CONFIG = '';

const SCRIPT = new URL('./prs-snapshot.mjs', import.meta.url).pathname;

function run(...args) {
    return runWith(process.env, ...args);
}

function runWith(env, ...args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

function fixture(dir, name, snapshot) {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(snapshot));
    return p;
}

function pr(overrides = {}) {
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
    assert.match(r.err, /Usage: prs-snapshot\.mjs diff/);
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

const good = (o = {}) => pr({ reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', threadsComplete: true, ...o });
const thread = (id, isResolved) => ({ id, isResolved, isOutdated: false, author: 'rev' });

test('a PR is ready only when approved, not a draft, with zero unresolved threads, MERGEABLE, and every condition says why when it fails', () => {
    assert.deepEqual(readiness(good()), { ready: true, reasons: [] });
    assert.deepEqual(readiness(good({ threads: [thread('a', true)] })).ready, true, 'resolved threads do not count');
    const why = (o) => readiness(good(o)).reasons.join('|');
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

test('ready <snapshot> prints the report offline, and a missing argument prints usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const r = run('ready', fixture(dir, 's.json', { prs: [good({ threads: [thread('t', false)] })] }));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Ready to merge \(0\)/);
    assert.match(r.out, /1 unresolved review thread/);
    assert.match(run('ready').err, /Usage: prs-snapshot\.mjs ready/);
});

test('--ready on a live fetch reports mergeable and thread state from the board query', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prs-snap-test-'));
    const nodes = [prNode(1, { reviewDecision: 'APPROVED', mergeable: 'MERGEABLE' }), prNode(2, { reviewDecision: 'APPROVED', mergeable: 'CONFLICTING' })];
    const r = runWith(installGhStub({ pages: paged(nodes) }), '--ready', '--dry-run', '--vault', dir);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Ready to merge \(1\):\n  org\/repo#1 /);
    assert.match(r.out, /org\/repo#2 — merge conflict/);
});

test('after a merge, requerySiblings re-asks the mergeable state of open PRs in that repo until it is known, and leaves other repos alone', () => {
    const prev = { prs: [good({ key: 'a/x#1', repo: 'a/x', number: 1 }), good({ key: 'a/x#2', repo: 'a/x', number: 2 }), good({ key: 'b/y#3', repo: 'b/y', number: 3 })] };
    const curr = { prs: [good({ key: 'a/x#2', repo: 'a/x', number: 2, mergeable: 'UNKNOWN' }), good({ key: 'b/y#3', repo: 'b/y', number: 3, mergeable: 'UNKNOWN' })] };
    const answers = ['UNKNOWN', 'CONFLICTING'];
    const asked = [];
    const run = (args) => { asked.push(args.slice(2, 4).join(' ')); return { status: 0, stdout: `${answers.shift()}\n` }; };
    assert.deepEqual(requerySiblings(prev, curr, { run, wait: () => {} }), ['a/x']);
    assert.deepEqual(asked, ['2 --repo', '2 --repo'], 'two asks for the sibling, none for the other repo');
    assert.deepEqual(curr.prs.map((p) => p.mergeable), ['CONFLICTING', 'UNKNOWN']);
    const failing = { prs: [good({ key: 'a/x#2', repo: 'a/x', number: 2, mergeable: 'MERGEABLE' })] };
    requerySiblings(prev, failing, { run: () => ({ status: 1, stdout: '' }), wait: () => {} });
    assert.equal(failing.prs[0].mergeable, 'MERGEABLE', 'a failed lookup keeps what the board query said');
    const none = { prs: [good({ key: 'a/x#2', repo: 'a/x', number: 2 })] };
    assert.deepEqual(requerySiblings({ prs: none.prs }, none, { run: () => { throw new Error('no merge, no asks'); } }), []);
});
