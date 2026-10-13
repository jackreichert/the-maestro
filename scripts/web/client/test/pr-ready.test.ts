// Run: node --test scripts/web/client/test/pr-ready.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyToMerge } from '../src/pr-ready.ts';

const base = { isDraft: false, review: 'approved', unresolved: 0, mergeable: 'mergeable' } as const;

test('ready to merge needs approval, zero unresolved threads and a clean mergeable state, all three', () => {
  assert.equal(readyToMerge(base), true);
  assert.equal(readyToMerge({ ...base, review: 'none' }), false, 'an empty decision is not an approval');
  assert.equal(readyToMerge({ ...base, review: 'changes-requested' }), false);
  assert.equal(readyToMerge({ ...base, unresolved: 1 }), false);
  assert.equal(readyToMerge({ ...base, mergeable: 'conflicting' }), false);
  assert.equal(readyToMerge({ ...base, mergeable: 'unknown' }), false, 'still computing is not clean');
});

test('a draft is never ready, however clean', () => {
  assert.equal(readyToMerge({ ...base, isDraft: true }), false);
});
