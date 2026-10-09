// Run: node --test scripts/lib/draft-promotion.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDraftPromoted } from './draft-promotion.ts';

test('only a draft that is no longer a draft is a promotion', () => {
  assert.equal(isDraftPromoted({ isDraft: true }, { isDraft: false }), true);
  assert.equal(isDraftPromoted({ isDraft: true }, { isDraft: true }), false);
  assert.equal(isDraftPromoted({ isDraft: false }, { isDraft: false }), false);
  assert.equal(isDraftPromoted({ isDraft: false }, { isDraft: true }), false, 'converting back to draft is not a promotion');
  assert.equal(isDraftPromoted(undefined, { isDraft: false }), false, 'a PR with no previous state is not a promotion');
});
