// Run: node --test scripts/lib/review-queue.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAESTRO_LOCAL_CONFIG = '';
const { reviewQueue, reviewQueueLine, readSnapshotPrs, readQueue, queueExitCode, queueText, boardQueue, staleSuffix, footerQueue, queueCount } = await import('./review-queue.ts');

const prs = (...drafts: boolean[]) => drafts.map((isDraft) => ({ isDraft }));

test('drafts do not count toward the queue', () => {
  assert.deepEqual(reviewQueue(prs(false, true, true, false), 4), { count: 2, cap: 4, full: false, selfReview: 0, waitingOnYou: 0, twins: 0 });
});

test('the queue is full at the cap, not above it', () => {
  assert.equal(reviewQueue(prs(false, false, false), 4).full, false);
  assert.equal(reviewQueue(prs(false, false, false, false), 4).full, true);
  assert.equal(reviewQueue(prs(false, false, false, false, false), 4).full, true);
});

test('an empty list is an empty queue', () => {
  assert.deepEqual(reviewQueue([], 4), { count: 0, cap: 4, full: false, selfReview: 0, waitingOnYou: 0, twins: 0 });
});

test('the board line shows N of cap and marks a full queue', () => {
  assert.equal(reviewQueueLine({ count: 3, cap: 4, full: false, selfReview: 0, waitingOnYou: 0, twins: 0 }), 'review queue: 3 of 4 waiting on reviewers');
  assert.equal(reviewQueueLine({ count: 4, cap: 4, full: true, selfReview: 0, waitingOnYou: 0, twins: 0 }), 'review queue: 4 of 4 waiting on reviewers (full)');
});

test('readSnapshotPrs reads a snapshot and refuses a malformed one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'));
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ takenAt: '2026-01-01T00:00:00Z', prs: [{ isDraft: false }, { isDraft: true }] }));
  assert.deepEqual(readSnapshotPrs(good), { prs: [{ isDraft: false }, { isDraft: true }], takenAt: '2026-01-01T00:00:00Z' });
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ prs: [{ title: 'no draft field' }] }));
  assert.equal(readSnapshotPrs(bad), null);
  writeFileSync(bad, '{not json');
  assert.equal(readSnapshotPrs(bad), null);
  assert.equal(readSnapshotPrs(join(dir, 'absent.json')), null);
});

const live = (...drafts: boolean[]) => () => ({ prs: prs(...drafts) });
const down = () => { throw new Error('gh api graphql failed: HTTP 502\nmore'); };
const stored = (takenAt?: string) => () => ({ prs: prs(false, false, false, false), takenAt });
const NOW = new Date('2026-01-01T01:00:00Z');

test('readQueue prefers the live read and exits 0 with room', () => {
  const r = readQueue({ fetchLive: live(false, false), readStored: () => null }, 4);
  assert.equal(r.ok && r.source, 'live');
  assert.equal(queueExitCode(r), 0);
  assert.deepEqual(queueText(r), ['review queue: 2 of 4 waiting on reviewers (live)']);
});

test('readQueue exits 1 and names the rule when the queue is full', () => {
  const r = readQueue({ fetchLive: live(false, false, false, false), readStored: () => null }, 4);
  assert.equal(queueExitCode(r), 1);
  assert.match(queueText(r).join('\n'), /review queue: 4 of 4 waiting on reviewers \(full\) \(live\)\nQueue full: hold pushes of new PRs and do not mark drafts ready \(keep working locally\); fixes/);
});

test('a failed live read falls back to the stored snapshot and says so', () => {
  const r = readQueue({ fetchLive: down, readStored: stored('2026-01-01T00:00:00Z') }, 4, NOW);
  assert.equal(r.ok && r.source, 'snapshot');
  assert.equal(queueExitCode(r), 1);
  assert.match(queueText(r)[0] as string, /stored snapshot 2026-01-01T00:00:00Z; live read failed: gh api graphql failed: HTTP 502\)$/);
});

test('with no live read and no snapshot the queue is unknown (exit 2), never empty', () => {
  const r = readQueue({ fetchLive: down, readStored: () => null }, 4);
  assert.equal(r.ok, false);
  assert.equal(queueExitCode(r), 2);
  assert.match(queueText(r).join('\n'), /Treat the queue as full/);
});

test('the cap passed in applies to either source', () => {
  const r = readQueue({ fetchLive: live(false, false), readStored: () => null }, 2);
  assert.equal(queueExitCode(r), 1);
});

test('boardQueue reads the stored snapshot for the board and footer, and flags a stale one', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  const snap = (takenAt: string, ...drafts: boolean[]) => ({ prs: prs(...drafts), takenAt });
  assert.deepEqual(boardQueue(snap('2026-10-06T11:55:00Z', false, false, false, true), 4, now), { text: 'review queue: 3 of 4 waiting on reviewers', footer: '**Review queue:** 3 of 4 waiting on reviewers' });
  assert.equal(boardQueue(snap('2026-10-06T11:55:00Z', false, false, false, false), 4, now)?.text, 'review queue: 4 of 4 waiting on reviewers (full)');
  assert.equal(boardQueue(snap('2026-10-06T07:00:00Z', false), 4, now)?.text, 'review queue: 1 of 4 waiting on reviewers (snapshot 5h old)');
  assert.equal(boardQueue(null, 4, now), null);
});

test('staleSuffix is silent under ten minutes or with no usable time, names minutes under an hour, and counts days past two', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  assert.equal(staleSuffix('2026-10-06T11:55:00Z', now), '');
  assert.equal(staleSuffix('2026-10-06T11:10:00Z', now), ' (snapshot 50m old)');
  assert.equal(staleSuffix(undefined, now), '');
  assert.equal(staleSuffix('garbage', now), '');
  assert.equal(staleSuffix('2026-10-03T12:00:00Z', now), ' (snapshot 3d old)');
});

test('a snapshot over six hours old, or undated, is refused as unknown rather than used', () => {
  const old = readQueue({ fetchLive: down, readStored: stored('2025-12-31T00:00:00Z') }, 4, NOW);
  assert.equal(queueExitCode(old), 2);
  assert.match(queueText(old)[0] as string, /over 6 hours old/);
  assert.equal(queueExitCode(readQueue({ fetchLive: down, readStored: stored(undefined) }, 4, NOW)), 2);
});

const inRepo = (repo: string, isDraft = false) => ({ repo, isDraft });

test('PRs in a self-review repo do not count toward the queue or fill it', () => {
  const list = [inRepo('org/a'), inRepo('org/b'), inRepo('me/tool'), inRepo('me/tool'), inRepo('me/tool'), inRepo('me/tool', true)];
  assert.deepEqual(reviewQueue(list, 4, ['me/tool']), { count: 2, cap: 4, full: false, selfReview: 3, waitingOnYou: 0, twins: 0 }, 'self-review drafts are drafts, not queue');
  assert.deepEqual(reviewQueue(list, 4), { count: 5, cap: 4, full: true, selfReview: 0, waitingOnYou: 0, twins: 0 }, 'with no self_review_repos nothing changes');
});

test('a PR with no repo is counted even when self-review repos are set', () => {
  assert.equal(reviewQueue([{ isDraft: false }], 4, ['me/*']).count, 1);
});

test('the push gate and the board line apply the same exclusion', () => {
  const stored = { prs: [inRepo('org/a'), inRepo('me/tool'), inRepo('me/tool')], takenAt: '2026-01-01T00:00:00Z' };
  const now = new Date('2026-01-01T00:05:00Z');
  const fail = { fetchLive: () => { throw new Error('offline'); }, readStored: () => stored };
  const r = readQueue(fail, 4, now, ['me/*']);
  assert.ok(r.ok && r.queue.count === 1 && r.queue.selfReview === 2);
  assert.equal(readQueue({ fetchLive: () => stored, readStored: () => null }, 2, now, ['me/*']).ok && queueExitCode(readQueue({ fetchLive: () => stored, readStored: () => null }, 2, now, ['me/*'])), 0);
  assert.equal(boardQueue(stored, 4, now, ['me/*'])?.text, 'review queue: 1 of 4 waiting on reviewers');
  assert.equal(boardQueue(stored, 4, now)?.text, 'review queue: 3 of 4 waiting on reviewers');
});

test('review_queue_orgs: only PRs owned by a listed owner count; another owner is never counted, even from a stale snapshot', () => {
  const list = [inRepo('Org/a'), inRepo('org/b'), inRepo('other-user/google-type'), inRepo('other-user/google-type'), inRepo('org/c', true)];
  assert.deepEqual(reviewQueue(list, 4, [], ['org']), { count: 2, cap: 4, full: false, selfReview: 0, waitingOnYou: 0, twins: 0 }, 'owner match ignores case, drafts and other owners are out');
  assert.equal(reviewQueue(list, 4).count, 4, 'with no owners configured nothing is filtered (the old behaviour)');
  assert.equal(reviewQueue([{ isDraft: false }], 4, [], ['org']).count, 1, 'a PR with no repo is still counted');
  assert.equal(reviewQueue([...list, inRepo('me/tool')], 4, ['me/tool'], ['org', 'me']).selfReview, 1, 'self_review_repos still works inside an allowed owner');
  const stored = { prs: list, takenAt: '2026-01-01T00:00:00Z' };
  const now = new Date('2026-01-01T00:05:00Z');
  assert.equal(boardQueue(stored, 4, now, [], ['org'])?.text, 'review queue: 2 of 4 waiting on reviewers');
  assert.equal(footerQueue(stored, 4, new Date('2026-01-01T01:00:00Z'), [], () => ({ prs: list }), ['org']), '**Review queue:** 2 of 4 waiting on reviewers');
  const down = { fetchLive: () => { throw new Error('offline'); }, readStored: () => stored };
  const r = readQueue(down, 4, now, [], ['org']);
  assert.ok(r.ok && r.queue.count === 2);
});

test('with a review pool the queue counts only pool repos: personal and stray repos are left out and reported as self-review', () => {
  const prs = [{ isDraft: false, repo: 'avonlea/a' }, { isDraft: false, repo: 'avonlea/b' }, { isDraft: false, repo: 'samwise/notes' }, { isDraft: false, repo: 'rosie/garden' }, { isDraft: true, repo: 'avonlea/c' }];
  assert.deepEqual(reviewQueue(prs, 2, ['!avonlea/*']), { count: 2, cap: 2, full: true, selfReview: 2, waitingOnYou: 0, twins: 0 });
  assert.equal(reviewQueue(prs, 4, []).count, 4, 'without a pool every non-draft PR counts');
});

test('footerQueue refreshes a snapshot older than 30 minutes and prints the live count, not the old one', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const old = { prs: prs(false, false, false, false), takenAt: '2026-01-01T01:00:00Z' };
  const calls: string[] = [];
  const refresh = () => { calls.push('live'); return { prs: prs(...new Array(11).fill(false)) }; };
  assert.equal(footerQueue(old, 4, now, [], refresh), '**Review queue:** 11 of 4 waiting on reviewers (7 over)');
  assert.deepEqual(calls, ['live']);
  const fresh = { prs: prs(false, false), takenAt: '2026-01-01T11:45:00Z' };
  assert.equal(footerQueue(fresh, 4, now, [], refresh), '**Review queue:** 2 of 4 waiting on reviewers (snapshot 15m old)');
  assert.deepEqual(calls, ['live'], 'a snapshot under 30 minutes old is not refreshed');
});

test('footerQueue says unknown, not an old number, when a stale snapshot cannot be refreshed or has no time', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const down = () => { throw new Error('gh failed'); };
  assert.equal(footerQueue({ prs: prs(false), takenAt: '2026-01-01T01:00:00Z' }, 4, now, [], down), '**Review queue:** unknown (snapshot 11h old; live refresh failed)');
  assert.equal(footerQueue({ prs: prs(false) }, 4, now, [], down), '**Review queue:** unknown (snapshot of unknown age; live refresh failed)');
  assert.equal(footerQueue(null, 4, now, [], down), null, 'no snapshot at all: the line stays absent');
});

test('footerQueue on a fresh snapshot words the count like the live read: over the cap says by how much', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const takenAt = '2026-01-01T11:55:00Z';
  const never = () => { throw new Error('a fresh snapshot must not trigger a live read'); };
  const open = (n: number) => ({ prs: prs(...new Array(n).fill(false)), takenAt });
  assert.equal(footerQueue(open(7), 4, now, [], never), '**Review queue:** 7 of 4 waiting on reviewers (3 over)');
  assert.equal(footerQueue(open(4), 4, now, [], never), '**Review queue:** 4 of 4 waiting on reviewers (full)');
  assert.equal(footerQueue(open(2), 4, now, [], never), '**Review queue:** 2 of 4 waiting on reviewers');
  const live = () => ({ prs: prs(...new Array(7).fill(false)) });
  assert.equal(footerQueue({ prs: [], takenAt: '2026-01-01T01:00:00Z' }, 4, now, [], live), footerQueue(open(7), 4, now, [], never)?.replace(/ \(snapshot.*$/, ''), 'both paths print the same text');
});

test('footerQueue switches from the snapshot to a live read at exactly 30 minutes', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  let lives = 0;
  const refresh = () => { lives++; return { prs: prs(false, false, false) }; };
  const snap = (takenAt: string) => ({ prs: prs(false), takenAt });
  assert.equal(footerQueue(snap('2026-01-01T11:30:01Z'), 4, now, [], refresh), '**Review queue:** 1 of 4 waiting on reviewers (snapshot 29m old)');
  assert.equal(lives, 0, '29m59s old: still the snapshot');
  assert.equal(footerQueue(snap('2026-01-01T11:30:00Z'), 4, now, [], refresh), '**Review queue:** 3 of 4 waiting on reviewers');
  assert.equal(lives, 1, 'exactly 30m old: live');
});

const pr = (o: Record<string, unknown>) => ({ isDraft: false, repo: 'org/a', ...o });

test('the cap counts only PRs waiting on reviewers: changes requested, conflicting and approved PRs are the author\'s own backlog', () => {
  const list = [
    pr({ reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE' }),
    pr({ reviewDecision: 'NONE', mergeable: 'UNKNOWN' }),
    pr({ reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE' }),
    pr({ reviewDecision: 'REVIEW_REQUIRED', mergeable: 'CONFLICTING' }),
    pr({ reviewDecision: 'APPROVED', mergeable: 'MERGEABLE' }),
    pr({ reviewDecision: null, mergeable: null }),
  ];
  assert.deepEqual(reviewQueue(list, 4), { count: 3, cap: 4, full: false, selfReview: 0, waitingOnYou: 3, twins: 0 });
  assert.equal(reviewQueue(list, 3).full, true, 'full is judged on the reviewer count alone');
});

test('a PR from a source that carries no review fields counts as waiting on reviewers (fail closed toward counting)', () => {
  assert.deepEqual(reviewQueue([{ isDraft: false, repo: 'org/a' }, { isDraft: false }], 4), { count: 2, cap: 4, full: false, selfReview: 0, waitingOnYou: 0, twins: 0 });
});

test('a staging twin with an open develop twin counts once; a lone staging PR and a stacked child still count', () => {
  const list = [
    pr({ repo: 'org/dtr', headRefName: 'feat/x', baseRefName: 'develop' }),
    pr({ repo: 'Org/dtr', headRefName: 'feat/x', baseRefName: 'staging' }),
    pr({ repo: 'org/dtr', headRefName: 'feat/lone', baseRefName: 'staging' }),
    pr({ repo: 'org/dtr', headRefName: 'feat/child', baseRefName: 'feat/parent' }),
  ];
  assert.deepEqual(reviewQueue(list, 4), { count: 3, cap: 4, full: false, selfReview: 0, waitingOnYou: 0, twins: 1 });
  const draftDev = [pr({ repo: 'org/dtr', headRefName: 'feat/x', baseRefName: 'develop', isDraft: true }), pr({ repo: 'org/dtr', headRefName: 'feat/x', baseRefName: 'staging' })];
  assert.equal(reviewQueue(draftDev, 4).count, 1, 'a draft develop twin is not in the queue, so the staging PR is the one reviewers read');
});

test('the footer wording names the reviewer count, the overage and the author\'s backlog', () => {
  const q = (count: number, waitingOnYou: number) => ({ count, cap: 4, full: count >= 4, selfReview: 0, waitingOnYou, twins: 0 });
  assert.equal(queueCount(q(11, 4)), '11 of 4 waiting on reviewers (7 over) \u00b7 4 waiting on you');
  assert.equal(queueCount(q(4, 0)), '4 of 4 waiting on reviewers (full)');
  assert.equal(queueCount(q(2, 1)), '2 of 4 waiting on reviewers \u00b7 1 waiting on you');
});

test('the push gate reads the same split: a live fetch of 18 PRs where 11 wait on reviewers is 11 of 4', () => {
  const list = [...Array(11).fill(0).map(() => pr({ reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE' })), ...Array(7).fill(0).map(() => pr({ reviewDecision: 'CHANGES_REQUESTED' }))];
  const r = readQueue({ fetchLive: () => ({ prs: list }), readStored: () => null }, 4);
  assert.equal(queueText(r)[0], 'review queue: 11 of 4 waiting on reviewers (7 over) \u00b7 7 waiting on you (live)');
  assert.equal(queueExitCode(r), 1);
});
