// Run: node --test scripts/lib/self-review.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSelfReview, splitSelfReview } from './self-review.ts';

test('an exact repo and an owner glob match, case-insensitively; other repos do not', () => {
  const globs = ['example-owner/tool', 'solo-owner/*'];
  assert.equal(isSelfReview('example-owner/tool', globs), true);
  assert.equal(isSelfReview('Example-Owner/Tool', globs), true);
  assert.equal(isSelfReview('solo-owner/anything', globs), true);
  assert.equal(isSelfReview('example-owner/other', globs), false);
  assert.equal(isSelfReview('example-owner/tool-extra', globs), false, 'an exact entry is not a prefix');
});

test('no globs, or no repo, means a PR is not self-review', () => {
  assert.equal(isSelfReview('example-owner/tool', []), false);
  assert.equal(isSelfReview(undefined, ['example-owner/*']), false);
  assert.equal(isSelfReview('', ['example-owner/*']), false);
});

test('regex characters in a glob are literal', () => {
  assert.equal(isSelfReview('ab/x', ['a.+/x']), false);
  assert.equal(isSelfReview('a.+/x', ['a.+/x']), true);
});

test('splitSelfReview keeps order and puts unknown repos with the org list', () => {
  const prs = [{ repo: 'o/a', n: 1 }, { repo: 'me/tool', n: 2 }, { n: 3 }, { repo: 'me/tool', n: 4 }];
  const { org, self } = splitSelfReview(prs, ['me/*']);
  assert.deepEqual(org.map((p) => p.n), [1, 3]);
  assert.deepEqual(self.map((p) => p.n), [2, 4]);
});
