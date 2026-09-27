// Run: node --test scripts/prs-snapshot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./prs-snapshot.mjs', import.meta.url).pathname;

function run(...args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
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
