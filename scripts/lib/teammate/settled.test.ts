// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/teammate/settled.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settledReason } from './settled.ts';
import type { SettledFacts, SettledReview } from './settled.ts';

const rev = (login: string, state: string, at: string, body = '', bot = false): SettledReview => ({ login, bot, state, at, body });
const facts = (over: Partial<SettledFacts> = {}): SettledFacts => ({
  state: 'OPEN', decision: null, author: 'pat-fake', self: 'me-fake', createdAt: '2026-10-01T00:00:00Z', headAt: '2026-10-01T00:00:00Z', requested: [], reviews: [], ...over,
});
const why = (over: Partial<SettledFacts> = {}): string | undefined => settledReason(facts(over))?.why;

test('an open PR nobody has looked at is not settled', () => {
  assert.equal(settledReason(facts()), null);
});

test('merged and closed PRs are settled whatever else is true', () => {
  assert.equal(why({ state: 'MERGED' }), 'merged');
  assert.equal(why({ state: 'CLOSED', requested: ['me-fake'] }), 'closed');
});

test('reviewDecision APPROVED settles it', () => {
  assert.equal(why({ decision: 'APPROVED' }), 'approved');
});

test('an APPROVED review from anyone at the live head settles it, but one before a later push does not', () => {
  assert.equal(why({ reviews: [rev('kim-fake', 'APPROVED', '2026-10-02T00:00:00Z')], headAt: '2026-10-01T12:00:00Z' }), 'approved');
  const stale = [rev('kim-fake', 'APPROVED', '2026-10-02T00:00:00Z')];
  assert.equal(why({ reviews: stale, headAt: '2026-10-03T00:00:00Z', requested: ['kim-fake'] }), undefined, 'pushed after the approval and the reviewer was asked again: back on the tab');
  assert.equal(why({ reviews: stale, headAt: '2026-10-03T00:00:00Z' }), 'picked-up', 'pushed after it with nobody asked: someone has it, but it is not an approval at the head');
});

test('an approval that the same person later withdrew with CHANGES_REQUESTED is not an approval', () => {
  const reviews = [rev('kim-fake', 'APPROVED', '2026-10-02T00:00:00Z'), rev('kim-fake', 'CHANGES_REQUESTED', '2026-10-03T00:00:00Z')];
  assert.equal(why({ reviews }), 'picked-up');
});

test('another person reviewing (APPROVED, CHANGES_REQUESTED, or COMMENTED with a body) picks it up', () => {
  assert.equal(why({ reviews: [rev('kim-fake', 'CHANGES_REQUESTED', '2026-10-02T00:00:00Z')] }), 'picked-up');
  assert.equal(why({ reviews: [rev('kim-fake', 'COMMENTED', '2026-10-02T00:00:00Z', 'Looks off in the loop.')] }), 'picked-up');
});

test('a bodiless COMMENTED review, a bot, the author and a pending or dismissed review do not pick it up', () => {
  assert.equal(why({ reviews: [rev('kim-fake', 'COMMENTED', '2026-10-02T00:00:00Z', '  ')] }), undefined);
  assert.equal(why({ reviews: [rev('copilot-pull-request-reviewer', 'COMMENTED', '2026-10-02T00:00:00Z', 'text', true)] }), undefined);
  assert.equal(why({ reviews: [rev('PAT-fake', 'COMMENTED', '2026-10-02T00:00:00Z', 'Replying to threads.')] }), undefined);
  assert.equal(why({ reviews: [rev('kim-fake', 'PENDING', '2026-10-02T00:00:00Z', 'x'), rev('lee-fake', 'DISMISSED', '2026-10-02T00:00:00Z', 'x')] }), undefined);
});

test('a review before the PR was opened does not count', () => {
  assert.equal(why({ reviews: [rev('kim-fake', 'APPROVED', '2026-09-30T00:00:00Z')], decision: null, headAt: '2026-09-29T00:00:00Z' }), 'approved', 'an approval is still an approval at the head');
  assert.equal(why({ reviews: [rev('kim-fake', 'COMMENTED', '2026-09-30T00:00:00Z', 'early')] }), undefined);
});

test('you were explicitly asked and have not reviewed: someone else picking it up does not remove it', () => {
  const reviews = [rev('kim-fake', 'COMMENTED', '2026-10-02T00:00:00Z', 'My take.')];
  assert.equal(why({ reviews, requested: ['ME-fake'] }), undefined);
  assert.equal(why({ reviews: [...reviews, rev('me-fake', 'COMMENTED', '2026-10-03T00:00:00Z', 'Mine.')], requested: ['me-fake'] }), 'picked-up', 'once you have reviewed, the ask no longer protects it');
});

test('the exception covers being picked up only: an approved PR leaves even when you were asked', () => {
  assert.equal(why({ decision: 'APPROVED', requested: ['me-fake'] }), 'approved');
  assert.equal(why({ state: 'MERGED', requested: ['me-fake'] }), 'merged');
});

test('the author pushing after the picking-up review and asking for another look brings the card back', () => {
  const reviews = [rev('kim-fake', 'CHANGES_REQUESTED', '2026-10-02T00:00:00Z')];
  assert.equal(why({ reviews, headAt: '2026-10-03T00:00:00Z', requested: ['kim-fake'] }), undefined, 'new commits and a re-request');
  assert.equal(why({ reviews, headAt: '2026-10-03T00:00:00Z', requested: [] }), 'picked-up', 'new commits but nobody asked again');
});

test('the reason names the person, so the rejected draft says why', () => {
  assert.match(settledReason(facts({ reviews: [rev('kim-fake', 'APPROVED', '2026-10-02T00:00:00Z')] }))?.text ?? '', /approved/i);
  assert.match(settledReason(facts({ reviews: [rev('kim-fake', 'COMMENTED', '2026-10-02T00:00:00Z', 'x')] }))?.text ?? '', /picked up/i);
});
