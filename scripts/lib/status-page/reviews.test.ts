// Run: node --test scripts/lib/status-page/reviews.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewVerdicts } from './reviews.ts';
import { loadPrs } from './generate.ts';
import type { RawPr } from './generate.ts';

const r = (login: string | null, state: string, submittedAt: string) => ({ state, submittedAt, author: login ? { login } : null });

test('someone who approved and later requested changes is not an approver', () => {
  const v = reviewVerdicts([r('fake-a', 'APPROVED', '2026-10-01T10:00:00Z'), r('fake-b', 'APPROVED', '2026-10-01T11:00:00Z'), r('fake-a', 'CHANGES_REQUESTED', '2026-10-02T09:00:00Z')]);
  assert.deepEqual(v.approvers, ['fake-b']);
  assert.deepEqual(v.changesBy, ['fake-a']);
});

test('the latest review wins whatever the order they arrive in, and a later approval clears earlier changes', () => {
  const v = reviewVerdicts([r('fake-a', 'APPROVED', '2026-10-03T00:00:00Z'), r('fake-a', 'CHANGES_REQUESTED', '2026-10-01T00:00:00Z')]);
  assert.deepEqual(v, { approvers: ['fake-a'], changesBy: [] });
});

test('a later comment does not undo an approval, a dismissed approval is gone, and authorless reviews are skipped', () => {
  const v = reviewVerdicts([r('fake-a', 'APPROVED', '2026-10-01T00:00:00Z'), r('fake-a', 'COMMENTED', '2026-10-02T00:00:00Z'), r('fake-b', 'APPROVED', '2026-10-01T00:00:00Z'), r('fake-b', 'DISMISSED', '2026-10-02T00:00:00Z'), r(null, 'APPROVED', '2026-10-02T00:00:00Z')]);
  assert.deepEqual(v, { approvers: ['fake-a'], changesBy: [] });
});

test('no reviews, no verdicts', () => {
  assert.deepEqual(reviewVerdicts([]), { approvers: [], changesBy: [] });
});

test('loadPrs carries the verdicts from the review history, and none when the cache has no history', () => {
  const raw = (reviews?: RawPr['reviews']): RawPr => ({ number: 1, title: 't', url: 'https://example.test/1', isDraft: false, baseRefName: 'develop', headRefName: 'x', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, repository: { nameWithOwner: 'acme/widgets' }, reviewThreads: { nodes: [] }, commits: { nodes: [] }, ...(reviews ? { reviews } : {}) });
  const ev = { items: [], ticketMap: {}, overrides: {}, repoStreams: {}, keyPattern: '\\b[A-Z]+-\\d+\\b' };
  const [withHistory, without] = loadPrs([raw({ nodes: [r('fake-a', 'APPROVED', '2026-10-01T00:00:00Z'), r('fake-a', 'CHANGES_REQUESTED', '2026-10-02T00:00:00Z')] }), raw()], ev);
  assert.deepEqual([withHistory?.approvers, withHistory?.changesBy], [[], ['fake-a']]);
  assert.equal(without?.approvers, undefined);
});
