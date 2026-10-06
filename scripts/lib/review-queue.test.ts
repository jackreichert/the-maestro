// Run: node --test scripts/lib/review-queue.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAESTRO_LOCAL_CONFIG = '';
const { reviewQueue, reviewQueueLine, readSnapshotPrs, readQueue, queueExitCode, queueText } = await import('./review-queue.ts');

const prs = (...drafts: boolean[]) => drafts.map((isDraft) => ({ isDraft }));

test('drafts do not count toward the queue', () => {
  assert.deepEqual(reviewQueue(prs(false, true, true, false), 4), { count: 2, cap: 4, full: false });
});

test('the queue is full at the cap, not above it', () => {
  assert.equal(reviewQueue(prs(false, false, false), 4).full, false);
  assert.equal(reviewQueue(prs(false, false, false, false), 4).full, true);
  assert.equal(reviewQueue(prs(false, false, false, false, false), 4).full, true);
});

test('an empty list is an empty queue', () => {
  assert.deepEqual(reviewQueue([], 4), { count: 0, cap: 4, full: false });
});

test('the cap defaults to 4', () => {
  assert.equal(reviewQueue([]).cap, 4);
});

test('the board line shows N of cap and marks a full queue', () => {
  assert.equal(reviewQueueLine({ count: 3, cap: 4, full: false }), 'review queue: 3 of 4');
  assert.equal(reviewQueueLine({ count: 4, cap: 4, full: true }), 'review queue: 4 of 4 (full)');
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
  const r = readQueue({ fetchLive: down, readStored: stored('2026-01-01T00:00:00Z') }, 4);
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
