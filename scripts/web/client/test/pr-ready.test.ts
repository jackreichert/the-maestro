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
  assert.equal(readyToMerge({ ...base, ci: 'FAILURE' }), false, 'failing CI goes back to the orchestra');
  assert.equal(readyToMerge({ ...base, ci: 'SUCCESS' }), true);
});

test('a draft is never ready, however clean', () => {
  assert.equal(readyToMerge({ ...base, isDraft: true }), false);
});

test('a staging PR waits on its develop twin: unmerged or not found is never ready, and clearing the wait makes it ready again', () => {
  assert.equal(readyToMerge({ ...base, waitsOnDevelop: { number: 3990, url: 'https://example.test/pull/3990' } }), false, 'twin still open');
  assert.equal(readyToMerge({ ...base, waitsOnDevelop: {} }), false, 'no twin found');
  assert.equal(readyToMerge({ ...base }), true, 'twin merged (no wait) and the other checks pass');
  assert.equal(readyToMerge({ ...base, review: 'none' }), false, 'a merged twin does not excuse the other checks');
});
