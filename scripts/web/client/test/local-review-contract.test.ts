// Run: node --test scripts/web/client/test/local-review-contract.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLocalReview } from '../src/contract.ts';
import { localUnit as unit } from './home-fixture.ts';

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

test('the clean-up counts and commands pass through; a body without them (an old snapshot) reads as nothing left out', () => {
  const cleanup = { landed: 2, superseded: 1, special: 0, commands: ["git -C 'a' branch -D 'b'"] };
  assert.deepEqual(sanitizeLocalReview(body({ cleanup }))!.data.cleanup, cleanup);
  assert.deepEqual(sanitizeLocalReview(body())!.data.cleanup, { landed: 0, superseded: 0, special: 0, commands: [] });
  assert.deepEqual(sanitizeLocalReview(body({ cleanup: { landed: -1, commands: 'x' } }))!.data.cleanup.commands, []);
});
