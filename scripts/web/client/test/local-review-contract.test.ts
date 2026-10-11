// Run: node --test scripts/web/client/test/local-review-contract.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLocalReview } from '../src/contract.ts';

export const unit = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'local:alpha#feat/one', repo: 'alpha', branch: 'feat/one', head: 'a'.repeat(40), ahead: 2, at: '2026-10-11T12:00:00-04:00', subject: 'add one',
  where: 'alpha', checkedOut: false, base: 'origin/staging', command: "git -C 'alpha' difftool 'origin/staging...feat/one'", verdict: { state: 'none' }, ...over,
});
const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ generatedAt: '2026-10-11T16:00:00Z', available: true, units: [unit()], more: 0, notes: ['read from local git'], ...over });

test('a well-formed queue passes through with its units', () => {
  const got = sanitizeLocalReview(body())!;
  assert.equal(got.dropped, 0);
  assert.equal(got.data.units[0]?.branch, 'feat/one');
  assert.deepEqual(got.data.notes, ['read from local git']);
});

test('a unit with a bad field is dropped and counted, the rest stay', () => {
  const got = sanitizeLocalReview(body({ units: [unit(), unit({ ahead: -1 }), unit({ verdict: { state: 'passed' } }), unit({ command: 7 }), 'x'] }))!;
  assert.equal(got.data.units.length, 1);
  assert.equal(got.dropped, 4);
});

test('an unavailable queue needs its reason, so "not read" is never an empty list', () => {
  assert.equal(sanitizeLocalReview(body({ available: false, units: [] })), null);
  assert.equal(sanitizeLocalReview(body({ available: false, reason: '', units: [] })), null);
  assert.equal(sanitizeLocalReview(body({ available: false, reason: 'No container folder is configured.', units: [] }))?.data.reason, 'No container folder is configured.');
});

test('a body that is not a queue is refused', () => {
  for (const bad of [null, [], 'x', {}, body({ available: 'yes' }), body({ units: 'none' }), body({ generatedAt: 5 })]) assert.equal(sanitizeLocalReview(bad), null);
});
