// Run: node --test scripts/lib/review-queue.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAESTRO_LOCAL_CONFIG = '';
const { reviewQueue, reviewQueueLine, readSnapshotPrs, readQueue, queueExitCode, queueText, boardQueue, staleSuffix } = await import('./review-queue.ts');

const prs = (...drafts: boolean[]) => drafts.map((isDraft) => ({ isDraft }));

test('drafts do not count toward the queue', () => {
  assert.deepEqual(reviewQueue(prs(false, true, true, false), 4), { count: 2, cap: 4, full: false, selfReview: 0 });
});

test('the queue is full at the cap, not above it', () => {
  assert.equal(reviewQueue(prs(false, false, false), 4).full, false);
  assert.equal(reviewQueue(prs(false, false, false, false), 4).full, true);
  assert.equal(reviewQueue(prs(false, false, false, false, false), 4).full, true);
});

test('an empty list is an empty queue', () => {
  assert.deepEqual(reviewQueue([], 4), { count: 0, cap: 4, full: false, selfReview: 0 });
});

test('the board line shows N of cap and marks a full queue', () => {
  assert.equal(reviewQueueLine({ count: 3, cap: 4, full: false, selfReview: 0 }), 'review queue: 3 of 4');
  assert.equal(reviewQueueLine({ count: 4, cap: 4, full: true, selfReview: 0 }), 'review queue: 4 of 4 (full)');
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
  assert.deepEqual(queueText(r), ['review queue: 2 of 4 (live)']);
});

test('readQueue exits 1 and names the rule when the queue is full', () => {
  const r = readQueue({ fetchLive: live(false, false, false, false), readStored: () => null }, 4);
  assert.equal(queueExitCode(r), 1);
  assert.match(queueText(r).join('\n'), /review queue: 4 of 4 \(full\) \(live\)\nQueue full: dispatch no new PR-producing work except fixes/);
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
  assert.deepEqual(boardQueue(snap('2026-10-06T11:30:00Z', false, false, false, true), 4, now), { text: 'review queue: 3 of 4', footer: '**Review queue:** 3 of 4' });
  assert.equal(boardQueue(snap('2026-10-06T11:30:00Z', false, false, false, false), 4, now)?.text, 'review queue: 4 of 4 (full)');
  assert.equal(boardQueue(snap('2026-10-06T07:00:00Z', false), 4, now)?.text, 'review queue: 1 of 4 (snapshot 5h old)');
  assert.equal(boardQueue(null, 4, now), null);
});

test('staleSuffix is silent under an hour or with no usable time, and counts days past two', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  assert.equal(staleSuffix('2026-10-06T11:10:00Z', now), '');
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
  assert.deepEqual(reviewQueue(list, 4, ['me/tool']), { count: 2, cap: 4, full: false, selfReview: 3 }, 'self-review drafts are drafts, not queue');
  assert.deepEqual(reviewQueue(list, 4), { count: 5, cap: 4, full: true, selfReview: 0 }, 'with no self_review_repos nothing changes');
});

test('a PR with no repo is counted even when self-review repos are set', () => {
  assert.equal(reviewQueue([{ isDraft: false }], 4, ['me/*']).count, 1);
});

test('the dispatch gate and the board line apply the same exclusion', () => {
  const stored = { prs: [inRepo('org/a'), inRepo('me/tool'), inRepo('me/tool')], takenAt: '2026-01-01T00:00:00Z' };
  const now = new Date('2026-01-01T00:30:00Z');
  const fail = { fetchLive: () => { throw new Error('offline'); }, readStored: () => stored };
  const r = readQueue(fail, 4, now, ['me/*']);
  assert.ok(r.ok && r.queue.count === 1 && r.queue.selfReview === 2);
  assert.equal(readQueue({ fetchLive: () => stored, readStored: () => null }, 2, now, ['me/*']).ok && queueExitCode(readQueue({ fetchLive: () => stored, readStored: () => null }, 2, now, ['me/*'])), 0);
  assert.equal(boardQueue(stored, 4, now, ['me/*'])?.text, 'review queue: 1 of 4');
  assert.equal(boardQueue(stored, 4, now)?.text, 'review queue: 3 of 4');
});
