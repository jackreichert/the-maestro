// Run: node --test scripts/lib/queue-gate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAESTRO_LOCAL_CONFIG = '';
import type { QueuePr } from './review-queue.ts';
const { readyGate, isGatedRepo } = await import('./queue-gate.ts');
const { reviewQueue } = await import('./review-queue.ts');

const open = (n: number, o: Partial<QueuePr> = {}): QueuePr[] => Array.from({ length: n }, () => ({ isDraft: false, repo: 'org/a', reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', ...o }));
const gate = (prs: QueuePr[], over: Record<string, unknown> = {}) => {
  const queue = reviewQueue(prs, 4, [], ['org']);
  return readyGate({ repo: 'org/a', candidate: {}, reading: { ok: true, queue, prs, source: 'live' }, cap: 4, selfReview: [], owners: ['org'], ...over });
};

test('a promotion is allowed while the queue has room and refused at or over the cap', () => {
  assert.equal(gate(open(3)).allow, true);
  const full = gate(open(4));
  assert.equal(full.allow, false);
  assert.match(full.message, /review queue: 4 of 4 waiting on reviewers \(full\)\. Not marking org\/a ready/);
  assert.match(full.message, /--over-cap "<reason>"/);
  assert.equal(gate(open(11)).allow, false);
});

test('changes-requested and conflicting PRs do not fill the queue, so they do not block a promotion', () => {
  const mixed = [...open(3), ...open(6, { reviewDecision: 'CHANGES_REQUESTED' }), ...open(2, { mergeable: 'CONFLICTING' })];
  assert.equal(gate(mixed).allow, true);
});

test('--over-cap lets a refused promotion through and says so with the reason', () => {
  const v = gate(open(5), { overCapReason: 'hotfix for prod' });
  assert.deepEqual([v.allow, v.allow && v.overridden], [true, true]);
  assert.match(v.message, /Marking ready over the cap: --over-cap "hotfix for prod"/);
  assert.equal(gate(open(5), { overCapReason: '   ' }).allow, false, 'a blank reason is no reason');
  const room = gate(open(1), { overCapReason: 'not needed' });
  assert.ok(room.allow && !room.overridden, 'an override that was not needed is not logged as one');
});

test('a staging PR whose develop twin is already ready adds nothing to the queue, so it is allowed at the cap', () => {
  const prs: QueuePr[] = [...open(3), { isDraft: false, repo: 'org/a', headRefName: 'feat/x', baseRefName: 'develop' }];
  const v = gate(prs, { candidate: { headRefName: 'feat/x', baseRefName: 'staging' } });
  assert.ok(v.allow);
  assert.match(v.message, /adds nothing to it/);
  assert.equal(gate(prs, { candidate: { headRefName: 'feat/y', baseRefName: 'staging' } }).allow, false, 'an unrelated staging PR does add');
  assert.equal(gate(open(4), { candidate: { reviewDecision: 'CHANGES_REQUESTED', mergeable: 'CONFLICTING' } }).allow, false, 'a conflict or change request today does not exempt the PR: it clears and the PR joins the queue');
});

test('an unreadable queue refuses (never empty), and the override still needs a reason', () => {
  const reading = { ok: false as const, error: 'cannot read the review queue: GitHub read failed (HTTP 502) and there is no usable snapshot' };
  const v = gate([], { reading });
  assert.equal(v.allow, false);
  assert.match(v.message, /Treat the queue as full/);
  assert.equal(gate([], { reading, overCapReason: 'gh is down, urgent' }).allow, true);
});

test('personal, self-review and other-owner repos are never gated', () => {
  assert.equal(isGatedRepo('org/a', [], ['org']), true);
  assert.equal(isGatedRepo('me/tool', ['me/tool'], ['org', 'me']), false, 'self-review');
  assert.equal(isGatedRepo('jackreichert/the-maestro', [], ['org']), false, 'owner outside review_queue_orgs');
  const reading = { ok: false as const, error: 'cannot read the review queue: x' };
  const v = readyGate({ repo: 'jackreichert/the-maestro', candidate: {}, reading, cap: 4, selfReview: [], owners: ['org'] });
  assert.ok(v.allow && !v.gated, 'not gated even when the queue cannot be read');
});
