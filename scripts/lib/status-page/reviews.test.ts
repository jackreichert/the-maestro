// Run: node --test scripts/lib/status-page/reviews.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewVerdicts } from './reviews.ts';

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
